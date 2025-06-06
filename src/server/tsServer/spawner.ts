/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path'
import { PluginManager } from '../../utils/plugins'
import { OngoingRequestCancellerFactory } from '../tsServer/cancellation'
import { ClientCapabilities, ClientCapability, ServerType } from '../typescriptService'
import API from '../utils/api'
import { SyntaxServerConfiguration, TsServerLogLevel, TypeScriptServiceConfiguration } from '../utils/configuration'
import Logger from '../utils/logger'
import { TypeScriptPluginPathsProvider } from '../utils/pluginPathsProvider'
import Tracer from '../utils/tracer'
import { ILogDirectoryProvider } from './logDirectoryProvider'
import { GetErrRoutingTsServer, ITypeScriptServer, ProcessBasedTsServer, SyntaxRoutingTsServer, TsServerDelegate, TsServerProcessFactory, TsServerProcessKind } from './server'
import { TypeScriptVersion, TypeScriptVersionProvider } from './versionProvider'

const enum CompositeServerType {
  /** Run a single server that handles all commands  */
  Single,

  /** Run a separate server for syntax commands */
  SeparateSyntax,

  /** Use a separate syntax server while the project is loading */
  DynamicSeparateSyntax,

  /** Only enable the syntax server */
  SyntaxOnly
}

export class TypeScriptServerSpawner {
  public constructor(
    private readonly _versionProvider: TypeScriptVersionProvider,
    private readonly _logDirectoryProvider: ILogDirectoryProvider,
    private readonly _pluginPathsProvider: TypeScriptPluginPathsProvider,
    private readonly _logger: Logger,
    private readonly _tracer: Tracer,
    private readonly _factory: TsServerProcessFactory,
  ) {}

  public spawn(
    version: TypeScriptVersion,
    capabilities: ClientCapabilities,
    configuration: TypeScriptServiceConfiguration,
    pluginManager: PluginManager,
    cancellerFactory: OngoingRequestCancellerFactory,
    delegate: TsServerDelegate,
  ): ITypeScriptServer {
    let primaryServer: ITypeScriptServer
    const serverType = this.getCompositeServerType(version, capabilities, configuration)
    const shouldUseSeparateDiagnosticsServer = this.shouldUseSeparateDiagnosticsServer(configuration)

    switch (serverType) {
      case CompositeServerType.SeparateSyntax:
      case CompositeServerType.DynamicSeparateSyntax:
        {
          const enableDynamicRouting = !shouldUseSeparateDiagnosticsServer && serverType === CompositeServerType.DynamicSeparateSyntax
          primaryServer = new SyntaxRoutingTsServer({
            syntax: this.spawnTsServer(TsServerProcessKind.Syntax, version, configuration, pluginManager, cancellerFactory),
            semantic: this.spawnTsServer(TsServerProcessKind.Semantic, version, configuration, pluginManager, cancellerFactory),
          }, delegate, enableDynamicRouting)
          break
        }
      case CompositeServerType.Single:
        {
          primaryServer = this.spawnTsServer(TsServerProcessKind.Main, version, configuration, pluginManager, cancellerFactory)
          break
        }
      case CompositeServerType.SyntaxOnly:
        {
          primaryServer = this.spawnTsServer(TsServerProcessKind.Syntax, version, configuration, pluginManager, cancellerFactory)
          break
        }
    }

    if (shouldUseSeparateDiagnosticsServer) {
      return new GetErrRoutingTsServer({
        getErr: this.spawnTsServer(TsServerProcessKind.Diagnostics, version, configuration, pluginManager, cancellerFactory),
        primary: primaryServer,
      }, delegate)
    }

    return primaryServer
  }

  private getCompositeServerType(
    version: TypeScriptVersion,
    capabilities: ClientCapabilities,
    configuration: TypeScriptServiceConfiguration,
  ): CompositeServerType {
    if (!capabilities.has(ClientCapability.Semantic)) {
      return CompositeServerType.SyntaxOnly
    }
    if (configuration.socketPath) {
      return CompositeServerType.Single
    }

    switch (configuration.useSyntaxServer) {
      case SyntaxServerConfiguration.Always:
        return CompositeServerType.SyntaxOnly

      case SyntaxServerConfiguration.Never:
        return CompositeServerType.Single

      case SyntaxServerConfiguration.Auto:
        if (version.version?.gte(API.v340)) {
          return version.version?.gte(API.v400)
            ? CompositeServerType.DynamicSeparateSyntax
            : CompositeServerType.SeparateSyntax
        }
        return CompositeServerType.Single
    }
  }

  private shouldUseSeparateDiagnosticsServer(
    configuration: TypeScriptServiceConfiguration,
  ): boolean {
    return configuration.enableProjectDiagnostics && configuration.socketPath == null
  }

  private spawnTsServer(
    kind: TsServerProcessKind,
    version: TypeScriptVersion,
    configuration: TypeScriptServiceConfiguration,
    pluginManager: PluginManager,
    cancellerFactory: OngoingRequestCancellerFactory,
  ): ITypeScriptServer {
    const apiVersion = version.version || API.defaultVersion

    const canceller = cancellerFactory.create(kind, this._tracer)
    const { args, tsServerLogFile, tsServerTraceDirectory } = this.getTsServerArgs(kind, configuration, version, apiVersion, pluginManager, canceller.cancellationPipeName)

    if (TypeScriptServerSpawner.isLoggingEnabled(configuration)) {
      if (tsServerLogFile) {
        this._logger.info(`<${kind}> Log file: ${tsServerLogFile}`)
      } else {
        this._logger.error(`<${kind}> Could not create log directory`)
      }
    }

    if (configuration.enableTsServerTracing) {
      if (tsServerTraceDirectory) {
        this._logger.info(`<${kind}> Trace directory: ${tsServerTraceDirectory}`)
      } else {
        this._logger.error(`<${kind}> Could not create trace directory`)
      }
    }

    this._logger.info(`<${kind}> Forking...`)
    const process = this._factory.fork(version, args, kind, configuration)
    this._logger.info(`<${kind}> Starting...`)

    return new ProcessBasedTsServer(
      kind,
      this.kindToServerType(kind),
      process!,
      tsServerLogFile,
      canceller,
      version,
      this._tracer)
  }

  private kindToServerType(kind: TsServerProcessKind): ServerType {
    switch (kind) {
      case TsServerProcessKind.Syntax:
        return ServerType.Syntax

      case TsServerProcessKind.Main:
      case TsServerProcessKind.Semantic:
      case TsServerProcessKind.Diagnostics:
      default:
        return ServerType.Semantic
    }
  }

  private getTsServerArgs(
    kind: TsServerProcessKind,
    configuration: TypeScriptServiceConfiguration,
    currentVersion: TypeScriptVersion,
    apiVersion: API,
    pluginManager: PluginManager,
    cancellationPipeName: string | undefined,
  ): { args: string[]; tsServerLogFile: string | undefined; tsServerTraceDirectory: string | undefined } {
    const args: string[] = []
    let tsServerLogFile: string | undefined
    let tsServerTraceDirectory: string | undefined

    if (kind === TsServerProcessKind.Syntax) {
      if (apiVersion.gte(API.v401)) {
        args.push('--serverMode', 'partialSemantic')
      } else {
        args.push('--syntaxOnly')
      }
    }

    if (apiVersion.gte(API.v250)) {
      args.push('--useInferredProjectPerProjectRoot')
    } else {
      args.push('--useSingleInferredProject')
    }

    if (configuration.disableAutomaticTypeAcquisition || kind === TsServerProcessKind.Syntax || kind === TsServerProcessKind.Diagnostics) {
      args.push('--disableAutomaticTypingAcquisition')
    }

    if (kind === TsServerProcessKind.Semantic || kind === TsServerProcessKind.Main) {
      // args.push('--enableTelemetry')
    }

    if (cancellationPipeName) {
      args.push('--cancellationPipeName', cancellationPipeName + '*')
    }

    if (TypeScriptServerSpawner.isLoggingEnabled(configuration)) {
      const logDir = this._logDirectoryProvider.getNewLogDirectory()
      if (logDir) {
        tsServerLogFile = path.join(logDir, `tsserver.log`)
        args.push('--logVerbosity', TsServerLogLevel.toString(configuration.tsServerLogLevel))
        args.push('--logFile', tsServerLogFile)
      }
    }

    if (configuration.enableTsServerTracing) {
      tsServerTraceDirectory = this._logDirectoryProvider.getNewLogDirectory()
      if (tsServerTraceDirectory) {
        args.push('--traceDirectory', tsServerTraceDirectory)
      }
    }

    const pluginPaths = this._pluginPathsProvider.getPluginPaths()

    if (pluginManager.plugins.length) {
      args.push('--globalPlugins', pluginManager.plugins.map(x => x.name).join(','))

      const isUsingBundledTypeScriptVersion = currentVersion.path === this._versionProvider.bundledVersion.tsServerPath
      for (const plugin of pluginManager.plugins) {
        if (isUsingBundledTypeScriptVersion || plugin.enableForWorkspaceTypeScriptVersions) {
          pluginPaths.push(plugin.path)
        }
      }
    }

    if (pluginPaths.length !== 0) {
      args.push('--pluginProbeLocations', pluginPaths.join(','))
    }

    if (configuration.npmLocation) {
      args.push('--npmLocation', `"${configuration.npmLocation}"`)
    }

    let locale = TypeScriptServerSpawner.getTsLocale(configuration)
    if (locale) args.push('--locale', locale)
    args.push('--noGetErrOnBackgroundUpdate')
    args.push('--validateDefaultNpmLocation')

    return { args, tsServerLogFile, tsServerTraceDirectory }
  }

  private static isLoggingEnabled(configuration: TypeScriptServiceConfiguration) {
    return configuration.tsServerLogLevel !== TsServerLogLevel.Off
  }

  private static getTsLocale(configuration: TypeScriptServiceConfiguration): string {
    return configuration.locale
      ? configuration.locale
      : 'en'
  }
}
