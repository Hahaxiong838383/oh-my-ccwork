import { ApiError, apiRequest, clearSession, hasSession, saveSession } from './api';
import type { BoundDevice, DeviceSnapshot, LiveDataApi } from './live-data';
import { dashboardDetails } from './real-details';

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(502, { error: 'invalid_response' });
  return value as JsonObject;
}
function successful(value: unknown) {
  const result = object(value);
  if (result.ok !== true) throw new ApiError(502, { error: 'invalid_response' });
  return result;
}
const numberOrNull = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;

export const liveApi: LiveDataApi = {
  hasSession, saveSession, clearSession,
  async sendCode(phone) {
    successful(await apiRequest('/api/auth/sms/send', { method: 'POST', data: { phone }, authenticated: false }));
  },
  async login(phone, code) {
    const result = successful(await apiRequest('/api/auth/sms/verify', { method: 'POST', data: { phone, code }, authenticated: false }));
    if (typeof result.token !== 'string' || !result.token.trim()) throw new ApiError(502, { error: 'invalid_response' });
    return { token: result.token };
  },
  async getDevices(): Promise<BoundDevice[]> {
    const result = successful(await apiRequest('/api/profile/bound-devices'));
    if (!Array.isArray(result.devices)) throw new ApiError(502, { error: 'invalid_response' });
    return result.devices.map(value => {
      const row = object(value);
      if (typeof row.publicId !== 'string' || !row.publicId || typeof row.sn !== 'string') throw new ApiError(502, { error: 'invalid_response' });
      return { publicId: row.publicId, sn: row.sn, note: typeof row.note === 'string' ? row.note : '', status: typeof row.status === 'string' ? row.status : '', brainOpened: row.brainOpened === true };
    });
  },
  async getSnapshot(publicId): Promise<DeviceSnapshot> {
    const result = successful(await apiRequest(`/v1/parent/devices/${encodeURIComponent(publicId)}/dashboard`));
    const data = object(result.data);
    const row = object(data.device);
    if (typeof row.online !== 'boolean' || !Object.prototype.hasOwnProperty.call(row, 'updatedAtMs')) throw new ApiError(502, { error: 'invalid_response' });
    return { online: row.online, updatedAtMs: numberOrNull(row.updatedAtMs), present: typeof row.present === 'boolean' ? row.present : null, brightnessLevel: numberOrNull(row.brightnessLevel), imageDistanceM: numberOrNull(row.imageDistanceM), imageDistanceState: typeof row.imageDistanceState === 'string' ? row.imageDistanceState : null, ...(['usage','ark','records','conversations'].some(key=>key in data)?{details:dashboardDetails(data)}:{}) };
  },
};
