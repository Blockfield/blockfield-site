export const kitFixture = () => {
  const bounds = {
    kits: [0, 64],
    variants: [1, 16],
    items: [0, 36],
    curios: [0, 16],
    team_armor: [0, 4],
    count: [1, 1024],
    deploymentCost: [0, 10000],
    playerLimit: [1, 999],
    knifeSlot: [0, 7],
    index: [0, 15],
    gunAmmo: [0, 1000],
    zoom: [0, 32],
    damage: [0, 10000],
    color: [0, 16777215],
    armorPlate: [0, 100],
  }
  const kit = {
    id: 'rifle',
    name: 'Винтовка',
    allowedModeIds: ['room', 'tdm', 'training'],
    deploymentCost: 0,
    playerLimit: 32,
    knifeSlot: 2,
    variants: [
      {
        id: 'basic',
        name: 'Основной',
        items: [
          {
            id: 'tacz:modern_kinetic_gun',
            count: 1,
            data: {
              gunId: 'test:rifle',
              gunAmmo: 30,
              fireMode: 'AUTO',
              attachments: { SCOPE: { id: 'test:scope', zoom: 1 } },
            },
          },
        ],
      },
    ],
    team_armor: { RedTeam: [{ id: 'test:armor', count: 1, data: { armorPlate: 50 } }] },
    curios: [{ id: 'test:uniform', count: 1, slot: 'uniform' }],
  }
  const sniper = {
    ...structuredClone(kit),
    id: 'sniper',
    name: 'Снайпер',
    allowedModeIds: ['awp', 'tdm', 'training'],
    deploymentCost: 800,
  }
  const snipers = {
    ...structuredClone(kit),
    id: 'snipers',
    name: 'Снайпер',
    allowedModeIds: ['snipers'],
  }
  return {
    schema: 1,
    revision: 4,
    fields: {
      idPattern: '[a-z0-9_]{1,32}',
      ...Object.fromEntries(Object.entries(bounds).map(([key, [min, max]]) => [key, { min, max }])),
      attachmentSlots: ['SCOPE', 'MUZZLE', 'STOCK', 'GRIP', 'LASER', 'EXTENDED_MAG'],
      fireModes: ['SEMI', 'AUTO', 'BURST'],
      itemData: [
        'gunId',
        'ammoId',
        'attachmentId',
        'throwableId',
        'gunAmmo',
        'fireMode',
        'bulletInBarrel',
        'creativeAmmo',
        'armorPlate',
        'color',
        'damage',
        'attachments',
      ],
    },
    modes: ['campaign', 'room', 'tdm', 'snipers', 'awp', 'deathmatch', 'training'].map((id) => ({
      id,
      fixedKitId: id === 'snipers' ? 'snipers' : id === 'awp' ? 'sniper' : null,
      defaultFixedKitId: id === 'snipers' ? 'snipers' : id === 'awp' ? 'sniper' : null,
      supportsFixedKit: id !== 'training',
    })),
    kits: [kit, snipers, sniper].map((kit) => ({
      id: kit.id,
      name: kit.name,
      defaults: structuredClone(kit),
      effective: structuredClone(kit),
      editable: true,
    })),
    items: [
      'minecraft:stone',
      'tacz:modern_kinetic_gun',
      'tacz:ammo',
      'tacz:ammo_box',
      'tacz:attachment',
      'lrtactical:throwable',
      'test:armor',
      'test:uniform',
    ].map((id) => ({ id, name: id, kind: id === 'test:armor' ? 'armor' : 'other' })),
    guns: [{ id: 'test:rifle', name: 'Винтовка' }],
    ammos: [{ id: 'test:round', name: 'Патроны' }],
    attachments: [{ id: 'test:scope', name: 'Прицел' }],
    throwables: [{ id: 'test:grenade', name: 'Граната' }],
    accessorySlots: ['uniform'],
  }
}
