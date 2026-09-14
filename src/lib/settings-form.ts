export type SettingsForm = {
  pvpEnabled: string; lobby: Record<string, string>; rooms: Record<string, string>;
  lockedClasses: string[]; hadLocks: boolean; balance: Record<string, Record<string, number | boolean>>;
};
/** PUT /api/admin/settings body from form values. An empty field or «По умолчанию» means the server default, so it is left out. */
export function settingsBody(expectedRevision: number, form: SettingsForm) {
  const numbers = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)]));
  const lobby = { ...(form.pvpEnabled === '' ? {} : { pvpEnabled: form.pvpEnabled === 'true' }), ...numbers(form.lobby) };
  const rooms = numbers(form.rooms);
  const balance = Object.fromEntries(Object.entries(form.balance).filter(([, v]) => Object.keys(v).length));
  return {
    expectedRevision,
    ...(Object.keys(lobby).length ? { lobby } : {}),
    ...(Object.keys(rooms).length ? { rooms } : {}),
    ...(form.lockedClasses.length || form.hadLocks ? { classLocks: form.lockedClasses } : {}),
    ...(Object.keys(balance).length ? { campaignBalance: balance } : {}),
  };
}
