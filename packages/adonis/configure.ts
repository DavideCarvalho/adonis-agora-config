import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace add @adonis-agora/config`:
 *
 * 1. registers the provider in `adonisrc.ts`;
 * 2. publishes `config/config.ts` as a tenant (the common case: one app reading from a server);
 * 3. adds the three tenant variables to the env validations.
 *
 * For the control plane, change `topology` and add `verifyTenant` (the docs show both shapes). The
 * provider is the same for every topology.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  // biome-ignore lint/suspicious/noExplicitAny: `updateRcFile` types its callback loosely.
  await codemods.updateRcFile((rcFile: any) => {
    rcFile.addProvider('@adonis-agora/config/config_provider');
  });

  const stubs = stubsRoot();
  await codemods.makeUsingStub(stubs, 'config/config.stub', {});
  await codemods.makeUsingStub(stubs, 'database/migrations/create_config_tables.stub', {});

  await codemods.defineEnvValidations({
    leadingComment: 'Agora config server',
    variables: {
      CONFIG_URL: 'Env.schema.string.optional()',
      CONFIG_APP: 'Env.schema.string.optional()',
      CONFIG_TOKEN: 'Env.schema.string.optional()',
    },
  });

  command.logger.info(
    'Tenants fetch their configuration at boot. To have the values available while config/*.ts load, run bootstrapConfig() at the top of bin/server.ts (see docs/tenant).',
  );
  command.logger.info(
    'A control plane must exempt its tenant API from Shield CSRF: exceptRoutes: (ctx) => configCsrfExceptions(ctx.request.url()), imported from @adonis-agora/config.',
  );
}
