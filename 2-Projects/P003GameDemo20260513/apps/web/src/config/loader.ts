import {
  dictionarySchema,
  dropTableSchema,
  ecoTankSchema,
  newbiePhasesSchema,
  type Dictionary,
  type DropTableEntry,
  type EcoPart,
  type NewbiePhaseConfig,
} from './schemas';

import dictionaryJson from './tables/dictionary.json';
import dropTableJson from './tables/drop-table.json';
import ecoTankJson from './tables/eco-tank.json';
import newbiePhaseJson from './tables/newbie-phase.json';

/**
 * 配置加载器 —— 启动时一次性 Zod 校验，失败立即抛错
 *
 * 业务代码统一通过 getDict / getDropTable / getEcoPart / getNewbiePhase 访问，
 * 禁止直接 import 任何 JSON。
 */
const dictionary: Dictionary = dictionarySchema.parse(dictionaryJson);
const dropTable: DropTableEntry[] = dropTableSchema.parse(dropTableJson);
const ecoTank: EcoPart[] = ecoTankSchema.parse(ecoTankJson);
const newbiePhases: NewbiePhaseConfig[] = newbiePhasesSchema.parse(newbiePhaseJson);

export function getDict<K extends keyof Dictionary>(key: K): Dictionary[K] {
  return dictionary[key];
}

export function getDropTableEntry(useDay: number, boxIndex: number): DropTableEntry | null {
  const direct = dropTable.find((e) => e.use_day === useDay && e.box_index === boxIndex);
  if (direct) return direct;
  return dropTable.find((e) => e.use_day === -1 && e.box_index === boxIndex) ?? null;
}

export function getEcoPart(partId: number): EcoPart | null {
  return ecoTank.find((p) => p.part_id === partId) ?? null;
}

export function getNewbiePhase(useDay: number): NewbiePhaseConfig | null {
  return newbiePhases.find((p) => useDay >= p.start_day && useDay <= p.end_day) ?? null;
}

export function allEcoParts(): EcoPart[] {
  return ecoTank;
}

export function allNewbiePhases(): NewbiePhaseConfig[] {
  return newbiePhases;
}
