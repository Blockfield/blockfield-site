/** Итоговый урон по игроку в стандартном матчевом armour-китке. Чистая функция для подсказки в редакторе оружия. */

export type DamagePart = 'head' | 'torso' | 'limbs'

/**
 * Константы стандартного матчевого кита в одном месте. BR сейчас 0.2 из-за бага
 * SBW (столкновение ID модификаторов: шлем перезаписывает грудь/ноги); если баг
 * починят, изменятся только коэффициенты ниже.
 */
export const MATCH_KIT = {
  /** Значение бронеплиты на груди. */
  plate: 30,
  /** Броня и прочность полного кита. */
  armor: 22,
  toughness: 11,
  /** Сопротивление пулям (BR). */
  bulletResistance: 0.2,
  /** Доля пробивающего урона после сопротивления: × (1 − 0.2·BR). */
  piercingFactor: 0.96,
  /** Доля обычного урона после сопротивления: × (1 − 0.8·BR). */
  normalFactor: 0.84,
} as const

/** Ваниль (CombatRules#getDamageAfterAbsorb): эффективная броня падает с ростом урона. */
export function vanillaAfterArmor(damage: number): number {
  const { armor, toughness } = MATCH_KIT
  const effective = Math.min(Math.max(armor - damage / (2 + toughness / 4), armor * 0.2), 20)
  return damage * (1 - effective / 25)
}

export function finalDamageVsMatchKit({
  damage,
  armorIgnore,
  headMult,
  bodyMult,
  part,
}: {
  damage: number
  armorIgnore: number
  headMult: number
  bodyMult: number
  part: DamagePart
}): number {
  const afterPart = damage * (part === 'head' ? headMult : 1) * bodyMult
  const piercing = afterPart * armorIgnore * MATCH_KIT.piercingFactor
  const normal = vanillaAfterArmor(afterPart * (1 - armorIgnore) * MATCH_KIT.normalFactor)
  return piercing + normal
}
