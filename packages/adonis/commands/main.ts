import { ListLoader } from '@adonisjs/core/ace';
import AgoraDoctor from './agora_doctor.js';
import {
  ConfigAudit,
  ConfigDiff,
  ConfigEntryGet,
  ConfigEntryList,
  ConfigEntrySet,
  ConfigEntryUnset,
  ConfigEnv,
  ConfigHistory,
  ConfigRollback,
  ConfigVersionShow,
} from './config.js';
import ConfigPull from './pull.js';

/**
 * The commands of `@adonis-agora/config`, registered by `configure` with
 * `rcFile.addCommand('@adonis-agora/config/commands')`. They never boot a worker: they read and
 * write the same store the console does, with `cli:<os user>` as the audit actor.
 */
const loader = new ListLoader([
  ConfigEntryList,
  ConfigEntryGet,
  ConfigEntrySet,
  ConfigEntryUnset,
  ConfigHistory,
  ConfigVersionShow,
  ConfigDiff,
  ConfigRollback,
  ConfigAudit,
  ConfigEnv,
  ConfigPull,
  AgoraDoctor,
]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
