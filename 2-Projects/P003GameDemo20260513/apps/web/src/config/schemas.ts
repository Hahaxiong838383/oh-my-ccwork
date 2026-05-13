import { z } from 'zod';

export const dictionarySchema = z.object({
  Shortleave: z.number().int().positive(),
  Longleave: z.number().int().positive(),
  Backtime: z.number().int().positive(),
  Offlinetime: z.number().int().positive(),
  NoanswerTime: z.number().int().positive(),
  RewardPerHour: z.number().int().positive(),
  MaxHours: z.number().int().positive(),
  LowSupplies: z.number().int().positive(),
  MiddleSupplies: z.number().int().positive(),
  HighSupplies: z.number().int().positive(),
  ConfirmExitTimeout: z.number().int().positive(),
  SettingsAutoClose: z.number().int().positive(),
  TodayCutoffHour: z.number().int().min(0).max(23),
  SleepStartHour: z.number().int().min(0).max(23),
  SleepEndHour: z.number().int().min(0).max(23),
});

export type Dictionary = z.infer<typeof dictionarySchema>;

export const dropTableEntrySchema = z.object({
  use_day: z.number().int(),
  box_index: z.number().int().positive(),
  focus_seconds: z.number().int().positive(),
  box_level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  reward_id: z.number().int().positive(),
});
export const dropTableSchema = z.array(dropTableEntrySchema);
export type DropTableEntry = z.infer<typeof dropTableEntrySchema>;

export const ecoPartSchema = z.object({
  part_id: z.number().int(),
  name: z.string(),
  level: z.number().int().min(0).max(3),
  is_default: z.boolean().optional(),
  unlock_voice_id: z.number().int().optional(),
  first_get_coins: z.number().int().nonnegative(),
  repeat_get_coins: z.number().int().nonnegative(),
});
export const ecoTankSchema = z.array(ecoPartSchema);
export type EcoPart = z.infer<typeof ecoPartSchema>;

export const newbiePhaseSchema = z.object({
  phase_id: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  name: z.string(),
  start_day: z.number().int().positive(),
  end_day: z.number().int().positive(),
  halo_color: z.enum(['gold', 'purple', 'blue']),
  stardust_multiplier: z.number().positive(),
  first_box_upgrade_weights: z.record(z.string(), z.number().nonnegative()),
  daily_greet_voice_id: z.number().int(),
});
export const newbiePhasesSchema = z.array(newbiePhaseSchema);
export type NewbiePhaseConfig = z.infer<typeof newbiePhaseSchema>;
