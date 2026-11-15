/**
 * A local, structural mirror of the `@adonis-agora/telescope` extension SDK contract. This package
 * never imports `@adonis-agora/telescope` (it is an optional peer in another repo); the exported
 * extension object satisfies its `TelescopeExtension` structurally. Keep this in lockstep with
 * `@adonis-agora/telescope`'s `extension/types.ts` (the same shape durable/media/payments declare).
 */

/** The slice of a telescope entry the data providers read. */
export interface TelescopeEntryLike {
  content?: unknown;
  tag?: string;
  createdAt?: Date | string;
}

/** The slice of the telescope store the data providers read (a subset of `TelescopeStore`). */
export interface TelescopeStoreLike {
  list(query?: { type?: string; tag?: string; limit?: number }): Promise<TelescopeEntryLike[]>;
}

/** The slice of the AdonisJS container an extension uses to resolve host services. */
export interface ContainerLike {
  make<T>(token: unknown): Promise<T>;
}

/** Read-only context handed to every extension hook. */
export interface ExtensionContext {
  readonly store: TelescopeStoreLike;
  readonly container: ContainerLike;
  readonly config: unknown;
}

export interface PanelThresholds {
  warn: number;
  bad: number;
  direction: 'up-bad' | 'down-bad';
}

export interface DashboardSection {
  title?: string;
  cols?: 2 | 3 | 4;
  panels: Panel[];
}

export interface DashboardSpec {
  id: string;
  label: string;
  navGroup?: string;
  panels: Panel[];
  sections?: DashboardSection[];
}

export interface DataBinding {
  provider: string;
  query?: Record<string, unknown>;
}

export interface LinkSpec {
  href: string;
  external?: boolean;
}

export interface Column {
  key: string;
  label: string;
  link?: LinkSpec;
}

export type Panel =
  | {
      kind: 'stat';
      title: string;
      data: DataBinding;
      format?: 'number' | 'percent' | 'duration' | 'rate';
      accent?: string;
      spark?: boolean;
      thresholds?: PanelThresholds;
    }
  | {
      kind: 'timeseries';
      title: string;
      data: DataBinding;
      series: string[];
      style?: 'area' | 'stacked';
    }
  | { kind: 'topN'; title: string; data: DataBinding; limit?: number }
  | {
      kind: 'table';
      title: string;
      data: DataBinding;
      columns: Column[];
      /** `{ rows, total, page, size }` mode; telescope passes `query.page`/`query.size`. */
      paged?: boolean;
    }
  | {
      kind: 'distribution';
      title: string;
      data: DataBinding;
      markers?: Array<'p50' | 'p95' | 'p99'>;
      format?: 'duration' | 'number';
    }
  | {
      kind: 'gauge';
      title: string;
      data: DataBinding;
      min?: number;
      max?: number;
      format?: 'number' | 'percent' | 'duration' | 'rate';
      thresholds?: PanelThresholds;
    }
  | { kind: 'breakdown'; title: string; data: DataBinding; style?: 'donut' | 'bar' };

export interface DataProvider {
  name: string;
  resolve(query: Record<string, unknown> | undefined, ctx: ExtensionContext): Promise<unknown>;
}

export interface TelescopeExtension {
  name: string;
  dashboards?(ctx: ExtensionContext): DashboardSpec[];
  dataProviders?(ctx: ExtensionContext): DataProvider[];
}
