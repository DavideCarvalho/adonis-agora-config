import type { DashboardSpec } from './telescope-sdk.js';

/** Options for the config "Configuration" dashboard. */
export interface ConfigDashboardOptions {
  /** Window (ms) for the activity panels. Default 24h; `0` shows everything recorded. */
  windowMs?: number;
}

/**
 * The "Configuration" dashboard: the health of the store (entries, secrets, unreadable values,
 * tenants seen), the write activity, and the audit surfaces (recent changes and secret reveals).
 * Pure data: every panel binds to a `config.*` provider by name.
 *
 * Links deliberately absent: this package's console can be mounted anywhere, and the extension
 * cannot know its path. Pass your own `extensions` entry if you want to add one.
 */
export function configDashboard(opts: ConfigDashboardOptions = {}): DashboardSpec {
  const windowMs = opts.windowMs ?? 24 * 60 * 60 * 1000;
  return {
    id: 'config.overview',
    label: 'Configuration',
    navGroup: 'Libraries',
    panels: [],
    sections: [
      {
        title: 'Health',
        cols: 4,
        panels: [
          {
            kind: 'stat',
            title: 'Entries',
            data: { provider: 'config.stats', query: { metric: 'entries' } },
            spark: false,
          },
          {
            kind: 'stat',
            title: 'Secrets',
            data: { provider: 'config.stats', query: { metric: 'secrets' } },
            spark: false,
          },
          {
            kind: 'stat',
            title: 'Sealed for an app',
            data: { provider: 'config.stats', query: { metric: 'sealed' } },
            spark: false,
          },
          {
            kind: 'stat',
            title: 'Unreadable secrets',
            data: { provider: 'config.stats', query: { metric: 'unreadable' } },
            spark: false,
            thresholds: { warn: 1, bad: 1, direction: 'up-bad' },
          },
        ],
      },
      {
        title: 'Activity',
        cols: 3,
        panels: [
          {
            kind: 'timeseries',
            title: 'Changes over time',
            data: { provider: 'config.changesOverTime', query: { windowMs } },
            series: ['set', 'unset', 'rollback'],
            style: 'stacked',
          },
          {
            kind: 'breakdown',
            title: 'Changes by action',
            data: { provider: 'config.actions', query: { windowMs } },
            style: 'donut',
          },
          {
            kind: 'stat',
            title: 'Tenants seen',
            data: { provider: 'config.stats', query: { metric: 'tenants' } },
            spark: false,
          },
        ],
      },
      {
        title: 'Audit',
        cols: 2,
        panels: [
          {
            kind: 'table',
            title: 'Recent changes',
            data: { provider: 'config.changes', query: { windowMs } },
            paged: true,
            columns: [
              { key: 'at', label: 'When' },
              { key: 'app', label: 'App' },
              { key: 'environment', label: 'Environment' },
              { key: 'action', label: 'Action' },
              { key: 'key', label: 'Key' },
              { key: 'actor', label: 'Actor' },
              { key: 'version', label: 'Version' },
            ],
          },
          {
            kind: 'table',
            title: 'Secret reveals',
            data: { provider: 'config.reveals', query: { windowMs } },
            paged: true,
            columns: [
              { key: 'at', label: 'When' },
              { key: 'app', label: 'App' },
              { key: 'environment', label: 'Environment' },
              { key: 'key', label: 'Key' },
              { key: 'actor', label: 'Actor' },
              { key: 'version', label: 'Version' },
            ],
          },
        ],
      },
      {
        title: 'Tenants',
        panels: [
          {
            kind: 'table',
            title: 'Seen by this control plane',
            data: { provider: 'config.tenants' },
            columns: [
              { key: 'app', label: 'App' },
              { key: 'environment', label: 'Environment' },
              { key: 'label', label: 'Label' },
              { key: 'capabilities', label: 'Capabilities' },
              { key: 'lastSeenAt', label: 'Last seen' },
              { key: 'version', label: 'Version' },
            ],
          },
        ],
      },
    ],
  };
}
