import { compactSlashCommand } from './compact';
import { copySlashCommand } from './copy';
import { effortSlashCommand } from './effort';
import { exitSlashCommand } from './exit';
import { modelSlashCommand } from './model';
import { planningSlashCommand } from './planning';
import { permissionsSlashCommand } from './permissions';
import { renameSlashCommand } from './rename';
import { resumeSlashCommand } from './resume';
import { statusSlashCommand } from './status';

export const builtinSlashCommands = [
  statusSlashCommand,
  modelSlashCommand,
  effortSlashCommand,
  permissionsSlashCommand,
  planningSlashCommand,
  compactSlashCommand,
  copySlashCommand,
  resumeSlashCommand,
  renameSlashCommand,
  exitSlashCommand,
];
