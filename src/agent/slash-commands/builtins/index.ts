import { archiveSlashCommand } from './archive';
import { compactSlashCommand } from './compact';
import { configSlashCommand } from './config';
import { copySlashCommand } from './copy';
import { deleteSlashCommand } from './delete';
import { effortSlashCommand } from './effort';
import { exitSlashCommand } from './exit';
import { fastSlashCommand } from './fast';
import { forkSlashCommand } from './fork';
import { modelSlashCommand } from './model';
import { planningSlashCommand } from './planning';
import { permissionsSlashCommand } from './permissions';
import { renameSlashCommand } from './rename';
import { resumeSlashCommand } from './resume';
import { statusSlashCommand } from './status';
import { btwSlashCommand } from './btw';
import { psSlashCommand } from './ps';
import { stopSlashCommand } from './stop';
import { goalSlashCommand } from './goal';
import { loopSlashCommand } from './loop';
import { subagentsSlashCommand } from './subagents';
import { agentsSlashCommand } from './agents';

export const builtinSlashCommands = [
  statusSlashCommand,
  modelSlashCommand,
  effortSlashCommand,
  fastSlashCommand,
  permissionsSlashCommand,
  configSlashCommand,
  planningSlashCommand,
  goalSlashCommand,
  loopSlashCommand,
  compactSlashCommand,
  copySlashCommand,
  psSlashCommand,
  stopSlashCommand,
  subagentsSlashCommand,
  agentsSlashCommand,
  resumeSlashCommand,
  forkSlashCommand,
  btwSlashCommand,
  renameSlashCommand,
  archiveSlashCommand,
  deleteSlashCommand,
  exitSlashCommand,
];
