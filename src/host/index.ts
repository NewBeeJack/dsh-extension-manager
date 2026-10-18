/**
 * dsh-extension-manager — Host half.
 *
 * One Cordis plugin row that owns every filesystem read, network probe and
 * package operation the Extension Manager Web page asks for. It wires durable
 * state, the two inventories, the update checkers, the update executor and the
 * HTTP surface together, and keeps inventory caches invalidated from the
 * official change events.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type {} from '@deepseek-ai/dsh-skill'
import type { HostServices } from './contracts'
import { ManagerLog } from './logs'
import { ManagerState, managerPaths } from './state'
import { TaskRegistry } from './tasks'
import { profileFacts, readManagerVersion } from './env'
import { PluginInventoryImpl } from './inventory/plugins'
import { SkillsInventoryImpl } from './inventory/skills'
import { PluginUpdateCheckerImpl } from './updates/pluginUpdates'
import { SkillUpdateCheckerImpl } from './updates/skillUpdates'
import { UpdateCheckService } from './updates/checker'
import { UpdateExecutor } from './updates/executor'
import { buildDiagnostics, registerRoutes } from './routes'

export const name = 'extension-manager'
export const inject = ['webServer']

/** Mount the manager: durable state, inventories, checkers, executor and routes. */
export async function apply(ctx: Context): Promise<void> {
  const facts = profileFacts(ctx)
  const paths = managerPaths(ctx)
  if (facts === undefined || paths === undefined) {
    ctx.logger.warn('[extension-manager] profileContext is unavailable; management endpoints stay disabled')
    return
  }
  const log = new ManagerLog(paths.logFile)
  const state = new ManagerState(ctx, paths)
  await state.initialize()
  log.info('host.start', { version: readManagerVersion(), profile: facts.name, dir: facts.dir, pid: process.pid })

  const tasks = new TaskRegistry()
  const plugins = new PluginInventoryImpl(ctx, state)
  const skills = new SkillsInventoryImpl(ctx, state, log)
  const services: HostServices = {
    ctx,
    facts,
    state,
    log,
    tasks,
    plugins,
    skills,
    scratchDir: paths.stagingDir,
  }
  const pluginChecker = new PluginUpdateCheckerImpl(ctx, state, log)
  const skillChecker = new SkillUpdateCheckerImpl(ctx, state, log)
  const checks = new UpdateCheckService(services, pluginChecker, skillChecker)
  const updates = new UpdateExecutor(services)

  ctx.effect(
    () => registerRoutes(ctx, {
      services,
      checks,
      updates,
      environment: () => buildDiagnostics(ctx, services),
      version: readManagerVersion(),
    }),
    'extension-manager: http routes',
  )

  // Official change signals keep the cached inventories honest.
  ctx.on('plugin-manager/changed', () => { plugins.invalidate() })
  ctx.on('skills/change', () => { skills.invalidate() })

  // Reconcile transactions a previous Host process left unfinished.
  if (updates.recover !== undefined) {
    void updates.recover().catch((error: unknown) => {
      log.error('host.recover-failed', { message: error instanceof Error ? error.message : String(error) })
    })
  }
  log.info('host.ready', { stateDir: paths.stateDir })
}
