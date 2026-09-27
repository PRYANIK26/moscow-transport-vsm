import type { PushSubscriptionInput } from '@vsm/shared';
import { api } from './api';

export function pushSupported() {
  return (
    window.isSecureContext &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

export function iosNeedsInstall() {
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  return ios && !standalone;
}

export function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function sameApplicationServerKey(subscription: PushSubscription, publicKey: string) {
  const actual = subscription.options.applicationServerKey;
  if (!actual) return false;
  const expected = applicationServerKey(publicKey);
  const bytes = new Uint8Array(actual);
  return (
    bytes.length === expected.length && bytes.every((value, index) => value === expected[index])
  );
}

export function subscriptionInput(subscription: PushSubscription): PushSubscriptionInput {
  const value = subscription.toJSON();
  if (!value.endpoint || !value.keys?.p256dh || !value.keys.auth)
    throw new Error('Браузер не предоставил ключи подписки. Повторите попытку.');
  return {
    endpoint: value.endpoint,
    keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
  };
}

export async function unlinkPushForLogout(notificationsEnabled: boolean) {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  if (notificationsEnabled) {
    try {
      await api.delete('/notifications/push/subscriptions', { endpoint: subscription.endpoint });
    } catch {
      // Logout also revokes subscriptions belonging to this auth session.
    }
  }
  await subscription.unsubscribe();
}
