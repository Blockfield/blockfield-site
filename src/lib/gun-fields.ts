import type { GunBalanceCatalog, GunDefinition, GunField } from './gun-balance.ts'

export const BODY_PARTS = [
  'head',
  'torso',
  'left_arm',
  'right_arm',
  'left_leg',
  'right_leg',
] as const

export function weaponFields(catalog: GunBalanceCatalog, gun: GunDefinition): GunField {
  return gun.weaponKind === 'item' ||
    gun.weaponKind === 'throwable' ||
    gun.weaponKind === 'melee' ||
    gun.weaponKind === 'mounted'
    ? {
        type: 'object',
        nullable: false,
        fields: { body_part_multipliers: catalog.fields.fields!.body_part_multipliers },
      }
    : catalog.fields
}
