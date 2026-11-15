// System permission prompts (notifications, tracking, location, camera...) read from the
// screenshot text. iOS and Android draw these in the device's language, so the patterns
// cover the languages a variant run can switch to. Pure, fixture-tested.

const RULES = [
  [
    "notifications",
    /(would like to send you notifications|to send you notifications\?|möchte (dir|ihnen) mitteilungen senden|mitteilungen (zu )?senden|通知を送信|vous envoyer des notifications|enviarte notificaciones|enviar notificações|inviarti notifiche|알림을 보내|发送通知|傳送通知)/i,
  ],
  [
    "tracking",
    /(track your activity across other companies|ask app not to track|app bitten, kein tracking|nicht zu tracken|aktivitäten in apps und auf websites|アクティビティの追跡|トラッキングしないように|demander à l’?'?app de ne pas (vous )?suivre|pedir a la app que no rastree|solicitar que o app não rastreie|chiedi all'?’?app di non tracciare|추적하지 않도록|要求app不跟踪)/i,
  ],
  ["location", /((use|access) your (current )?location|location.{0,60}(while using the app|allow once)|standort.{0,80}(erlauben|beim verwenden)|位置情報.{0,40}(許可|使用中))/i],
  ["camera", /(would like to access (the |your )?camera|möchte auf (die )?kamera zugreifen|カメラへのアクセス)/i],
  ["microphone", /(would like to access (the |your )?microphone|möchte auf das mikrofon zugreifen|マイクへのアクセス)/i],
  ["photos", /(would like to access (your )?photos|möchte auf (deine|ihre) fotos zugreifen|写真へのアクセス)/i],
  ["contacts", /(would like to access (your )?contacts|möchte auf (deine|ihre) kontakte zugreifen|連絡先へのアクセス)/i],
  ["bluetooth", /(would like to use bluetooth|möchte bluetooth verwenden|bluetoothの使用)/i],
];

/** The kind of system permission prompt on screen, or null. */
export function systemPrompt(text) {
  const t = String(text ?? "");
  for (const [kind, re] of RULES) if (re.test(t)) return kind;
  return null;
}

/** The answer button an agent should prefer (privacy first), in the screen's language. */
export const PREFERRED_ANSWER = {
  notifications: ["Don't Allow", "Don’t Allow", "Nicht erlauben", "許可しない", "Ne pas autoriser", "No permitir"],
  tracking: ["Ask App Not to Track", "App bitten, kein Tracking", "Appにトラッキングしないように要求", "Demander à l’app de ne pas suivre", "Pedir a la app que no rastree"],
};
