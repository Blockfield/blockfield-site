// The deploy workflow polls this until the live site reports the commit it has just pushed.
export function GET() {
  return Response.json(
    { commit: process.env.BUILD_COMMIT ?? null },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
