/**
 * Typed view of the client's global `useWorkspaces` standard hook.
 *
 * `ui-workspace` augments `GlobalStandardProps` with this selector hook, so any
 * slot component receives it without an inject face. This package does not
 * depend on `@deepseek-ai/dsh-api-workspace-controller`, so only the structural
 * subset the Skills workspace picker needs is declared here (the official hook
 * still satisfies it at runtime).
 */

/** The subset of one registered workspace the picker shows. */
export interface WorkspaceViewLike {
  readonly workspaceId: string
  /** Canonical host directory path, used as the `workspace` scan parameter. */
  readonly path: string
  /** User-visible title. */
  readonly title: string
}

/** The subset of the Workspace Controller snapshot the picker reads. */
export interface WorkspaceSnapshotLike {
  readonly items: readonly WorkspaceViewLike[]
  readonly state: 'idle' | 'loading' | 'error'
}

/**
 * Local structural twin of the store selector hook (`SnapshotSelectorHook` in
 * `@deepseek-ai/dsh-client-store`, which is not a direct dependency here).
 */
export type WorkspaceSelectorHook<Snapshot> = <Selected>(
  select: (snapshot: Snapshot) => Selected,
  equal?: (left: Selected, right: Selected) => boolean,
) => Selected

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    /** Global workspace selector supplied by ui-workspace. */
    useWorkspaces: WorkspaceSelectorHook<WorkspaceSnapshotLike>
  }
}

/** Stand-in hook used only if the ui-workspace plugin is absent. */
export const fallbackUseWorkspaces: WorkspaceSelectorHook<WorkspaceSnapshotLike> = <Selected>(
  select: (snapshot: WorkspaceSnapshotLike) => Selected,
): Selected => select({ items: [], state: 'idle' })
