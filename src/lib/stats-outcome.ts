/** Presentation only: never infer an FFA winner from a team, score or list order. */
export type HistoryOutcome = {
  mode: string; reason: string; winner: string; team: string; winnerUuid?: string | null;
};
export function outcomeLabel(result: HistoryOutcome, playerUuid: string): string {
  if (result.reason !== 'completed') return '';
  if (result.mode === 'deathmatch') {
    if (!result.winnerUuid) return '';
    return result.winnerUuid === playerUuid ? ' · победа' : ' · поражение';
  }
  if (result.winner === 'NONE' || result.team === 'NONE') return '';
  return result.winner === result.team ? ' · победа' : ' · поражение';
}
