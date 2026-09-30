/** Glicko-2 (Glickman, 2012). Pure math: no storage, no time source. */
export const GLICKO2 = {
  rating: 1500,
  rd: 350,
  volatility: 0.06,
  tau: 0.5,
  epsilon: 1e-6,
  scale: 173.7178,
} as const
export const RULES_VERSION = 'glicko2-v1'
export type Rating = { rating: number; rd: number; volatility: number }
export type Opponent = { rating: number; rd: number }
export type Game = { opponent: Opponent; score: 0 | 0.5 | 1 }

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI))
const expected = (mu: number, muj: number, phij: number) =>
  1 / (1 + Math.exp(-g(phij) * (mu - muj)))

export const initial = (): Rating => ({
  rating: GLICKO2.rating,
  rd: GLICKO2.rd,
  volatility: GLICKO2.volatility,
})

/** One rating period. An empty period only grows RD (Glicko-2 step 6). */
export function update(player: Rating, games: Game[], tau: number = GLICKO2.tau): Rating {
  const { scale, epsilon } = GLICKO2
  const mu = (player.rating - GLICKO2.rating) / scale,
    phi = player.rd / scale,
    sigma = player.volatility
  if (games.length === 0) return inflate(player, 1)
  let vInv = 0,
    sum = 0
  for (const { opponent, score } of games) {
    const muj = (opponent.rating - GLICKO2.rating) / scale,
      phij = opponent.rd / scale,
      gj = g(phij),
      e = expected(mu, muj, phij)
    vInv += gj * gj * e * (1 - e)
    sum += gj * (score - e)
  }
  const v = 1 / vInv,
    delta = v * sum,
    a = Math.log(sigma * sigma)
  const f = (x: number) =>
    (Math.exp(x) * (delta * delta - phi * phi - v - Math.exp(x))) /
      (2 * (phi * phi + v + Math.exp(x)) ** 2) -
    (x - a) / (tau * tau)
  let A = a,
    B: number
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v)
  else {
    let k = 1
    while (f(a - k * tau) < 0) k++
    B = a - k * tau
  }
  let fA = f(A),
    fB = f(B)
  while (Math.abs(B - A) > epsilon) {
    const C = A + ((A - B) * fA) / (fB - fA),
      fC = f(C)
    if (fC * fB <= 0) {
      A = B
      fA = fB
    } else fA /= 2
    B = C
    fB = fC
  }
  const sigmaNew = Math.exp(A / 2),
    phiStar = Math.sqrt(phi * phi + sigmaNew * sigmaNew)
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v),
    muNew = mu + phiNew * phiNew * sum
  return {
    rating: GLICKO2.rating + scale * muNew,
    rd: Math.min(GLICKO2.rd, scale * phiNew),
    volatility: sigmaNew,
  }
}

/** RD growth for whole idle rating periods before a new result; never above the initial RD. */
export function inflate(player: Rating, periods: number): Rating {
  let phi = player.rd / GLICKO2.scale
  for (let i = 0; i < periods && phi * GLICKO2.scale < GLICKO2.rd; i++)
    phi = Math.sqrt(phi * phi + player.volatility * player.volatility)
  return { ...player, rd: Math.min(GLICKO2.rd, phi * GLICKO2.scale) }
}

/** Season soft reset, once per season boundary crossed: half the distance to the initial rating, RD at least 200, volatility kept. */
export function softReset(player: Rating, seasons = 1): Rating {
  return {
    rating: GLICKO2.rating + 0.5 ** seasons * (player.rating - GLICKO2.rating),
    rd: Math.max(player.rd, 200),
    volatility: player.volatility,
  }
}

/** Team campaign = one game against a virtual opponent: mean rating, RMS deviation of the other side. */
export function composite(opponents: Rating[]): Opponent {
  if (opponents.length === 0) throw new Error('Composite opponent needs at least one player')
  const mu = opponents.reduce((s, o) => s + o.rating, 0) / opponents.length
  const rd = Math.sqrt(opponents.reduce((s, o) => s + o.rd * o.rd, 0) / opponents.length)
  return { rating: mu, rd }
}
