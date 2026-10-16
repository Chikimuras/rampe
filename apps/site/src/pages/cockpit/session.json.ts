// Auto-évaluation de Rampe (ADR-0021 §2), publiée telle quelle pour être téléchargée depuis le cockpit.
import sessionText from "../../../../../docs/audit-rampe/session.json?raw";

export const GET = () => new Response(sessionText, { headers: { "content-type": "application/json" } });
