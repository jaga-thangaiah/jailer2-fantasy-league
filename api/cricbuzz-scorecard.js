export default async function handler(req, res) {
  try {
    const matchId = (req.query.matchId || "").toString().trim();
    if (!matchId) return res.status(400).json({ error: "Missing ?matchId=" });

    const url = `http://mapps.cricbuzz.com/cbzios/match/${encodeURIComponent(matchId)}/scorecard`;

    const upstream = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json,text/plain,*/*",
        "Referer": "https://www.cricbuzz.com/"
      }
    });

    const text = await upstream.text();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=30");

    res.status(upstream.status).send(text);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
