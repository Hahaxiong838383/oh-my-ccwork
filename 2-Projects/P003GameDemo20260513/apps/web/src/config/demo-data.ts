export const DEMO_DATA = {
  offlineHours: 6,
  initialStardust: 1280,
  initialFamilyCoin: 50,
  nightReportBonus: { stardust: 120, familyCoin: 0 },
  supplyLevel: 'middle' as const,
  ecoUnlockAfterFocusCount: 2,
  ecoUnlock: {
    partId: 'light-tank',
    name: '灯光鱼缸',
    fromLevel: 1,
    toLevel: 2,
  },
  newbieAura: 'gold' as const,
  userGender: 'boy' as const,
  defaultWifiSignal: 'strong' as const,
} as const;
