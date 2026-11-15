// No-purchase guard. Gamedexy never automates a purchase, so every tap is
// checked here first. The rules live in code, not in the agent's prompt, so a
// confused or manipulated model cannot talk its way past them.
export const GUARD_VERSION = "guard-2026-11-10";

// "¥120" and "120円" (yen) and "￥120" too: language runs (gamedexy map variant --lang ja) show local prices.
export const PRICE = /(?:US\$|[$€£¥￥₹]|USD|EUR|GBP|JPY)\s*\d+(?:[.,]\d{1,3})*|\d+(?:[.,]\d{1,3})*\s*(?:[€£円]|USD|EUR|GBP|JPY)/i;
const PURCHASE_WORDS = /\b(buy|purchase|subscribe|subscription|1-tap buy|pay|checkout|unlock (?:for|now)|restore purchases?|free trial)\b/i;
// The same refusals in the languages a variant run can switch to (German, French, Spanish, Portuguese,
// Italian, Japanese, Korean, Chinese). Words, not layout: a guard that only reads English would wave a
// "Kaufen" or "購入" button through on a language run.
const PURCHASE_WORDS_INTL =
  /\b(kaufen|kauf|jetzt kaufen|abonnieren|abonnement|bezahlen|kostenlos testen|gratis testen|testversion|käufe wiederherstellen|acheter|achat|s'abonner|abonnement|payer|essai gratuit|comprar|compra|suscribirse|suscripción|pagar|prueba gratis|assinar|assinatura|acquista|abbonati|abbonamento|prova gratuita)\b|購入|買う|購読|定期購入|支払|お支払い|無料トライアル|購入を復元|復元する|구매|구독|결제|购买|購買|订阅|訂閱|支付|免费试用/i;
const AD_WORDS =
  /\b(watch(?: an?)? (?:ad|video)|watch & (?:get|earn)|watch (?:for|to) [\w ]{0,20}?(?:double|2x|x2|bonus|free|reward|extra)|ad\s*(?:to|for) (?:get|earn|claim)|free with ads?|get (?:it )?free\b.*\bad)\b/i;
// A store button whose price has not loaded yet shows a placeholder instead of a price.
// Found in the Game Map phase 1 test: Tether's gem packs read "LOADING..." and a tap aimed at a
// $0.99 pack went through because there was no price text to refuse.
const PRICE_PLACEHOLDER = /^\s*(loading(\.{1,3}|…)?|unavailable|price unavailable|--|—|get)\s*$/i;
const SIGN_IN = /\b(sign in|log in|login|sign up|create account|password|enter your email)\b/i;
const SIGN_IN_INTL = /\b(anmelden|einloggen|registrieren|passwort|konto erstellen|se connecter|connexion|mot de passe|créer un compte|iniciar sesión|contraseña|crear cuenta|entrar|senha|accedi|password)\b|ログイン|サインイン|パスワード|アカウント作成|新規登録|로그인|비밀번호|登录|登入|密码|密碼/i;
const AD_WORDS_INTL =
  /\b(werbung (an)?sehen|video (an)?sehen|video ansehen|regarder (une )?(pub|vidéo)|ver (un )?(anuncio|vídeo|video)|assistir (an[úu]ncio|v[íi]deo)|guarda (un )?(annuncio|video))\b|広告を見る|広告を視聴|動画を見る|動画を視聴|광고 보기|광고 시청|观看广告|看广告|觀看廣告/i;
// System purchase sheets: Google Play and Apple's StoreKit sheet copy.
const BILLING_SHEET =
  /(1-tap buy|google play\b.*\b(buy|purchase|subscribe)|payment method|confirm your in-app purchase|double-click to pay|\[environment: (sandbox|xcode)\]|apple account.*purchase|in-app-kauf bestätigen|zum bezahlen|achat intégré|compra dentro de la app|app内課金|アプリ内課金|購入を確認|ダブルクリックして支払う|앱 내 구입|App内购买)/i;
const DEVICE_BLOCK =
  /(cannot run on this device|can't run on this device|(isn't|is not|not) compatible with (this|your) device|unsupported device|emulators? (is |are )?not supported|emulator detected|integrity check failed|rooted device)/i;
const BILLING_PACKAGES = new Set(["com.android.vending"]);
const BILLING_ACTIVITY = /(billing|iab|purchase|checkout)/i;

export function blockedText(text) {
  if (PRICE.test(text)) return "price";
  if (PURCHASE_WORDS.test(text) || PURCHASE_WORDS_INTL.test(text)) return "purchase-word";
  if (AD_WORDS.test(text) || AD_WORDS_INTL.test(text)) return "rewarded-ad";
  if (SIGN_IN.test(text) || SIGN_IN_INTL.test(text)) return "sign-in";
  if (PRICE_PLACEHOLDER.test(text)) return "price-placeholder";
  return null;
}

/** Refuse a tap on, or right next to, blocked text. Boxes are in screenshot pixels. Pad: 6% of width. */
export function checkTap(boxes, x, y, width) {
  const pad = 0.06 * width;
  for (const b of boxes) {
    const reason = blockedText(b.text);
    if (reason && x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad) return `${reason}: "${b.text}"`;
  }
  return null;
}

/** Whole-screen conditions that stop the run. */
export function screenAlarm(fullText) {
  if (BILLING_SHEET.test(fullText)) return "purchase-sheet";
  if (DEVICE_BLOCK.test(fullText)) return "device-refused";
  return null;
}

/** Android: what is in front. "billing" stops the run. */
export function foregroundAlarm(pkg, activity, target) {
  if (BILLING_PACKAGES.has(pkg) || BILLING_ACTIVITY.test(activity)) return "billing";
  if (pkg && pkg !== target) return "left-game";
  return null;
}
