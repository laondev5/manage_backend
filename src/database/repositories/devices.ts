import type { Collections, DeviceDoc } from '../collections.js';

export async function upsertDevice(
  c: Collections,
  userId: string,
  input: {
    deviceId: string;
    platform: 'ios' | 'android';
    pushToken?: string | null;
    appVersion?: string;
    pushEnabled: boolean;
  },
): Promise<DeviceDoc> {
  const now = new Date();
  const doc = await c.devices.findOneAndUpdate(
    { userId, deviceId: input.deviceId },
    {
      $set: {
        platform: input.platform,
        pushToken: input.pushToken ?? null,
        pushEnabled: input.pushEnabled,
        appVersion: input.appVersion ?? null,
        lastSeenAt: now,
        revokedAt: null,
      },
      $setOnInsert: { userId, deviceId: input.deviceId, createdAt: now },
    },
    { upsert: true, returnDocument: 'after' },
  );
  if (!doc) throw new Error('Device registration failed.');
  return doc;
}

export async function listDevices(c: Collections, userId: string) {
  return c.devices.find({ userId }).sort({ lastSeenAt: -1 }).toArray();
}

export async function revokeDevice(c: Collections, userId: string, deviceId: string) {
  return c.devices.updateOne(
    { userId, deviceId },
    { $set: { revokedAt: new Date(), pushEnabled: false } },
  );
}

export async function pushTokensForRecipient(c: Collections, userId: string) {
  const devices = await c.devices
    .find({ userId, revokedAt: null, pushEnabled: true, pushToken: { $ne: null } })
    .toArray();
  return devices.map((device) => device.pushToken).filter((token): token is string => Boolean(token));
}
