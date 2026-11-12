/**
 * Recorded answers for the built-in job posts, so the simulated brain returns believable work in mock
 * mode. Keyed by job title. A live NEAR AI Cloud model writes these for real when INFERENCE_MODE=live.
 */
export const RECORDED_WORK: Record<string, string> = {
  'Summarise a city council meeting': [
    '- Bike lanes on Market St approved 6–3; construction starts in March.',
    '- Library open until 9pm on weekdays, paid for by parking up $0.50/hour.',
    '- Leaf-blower ban is on hold until a noise study reports in June.',
    '- The budget office expects a $2.1M shortfall next year.',
    '- Net: more cycling and reading, pricier parking, and a tight budget ahead.',
  ].join('\n'),
  'One-paragraph summary of a product review thread':
    'Owners love the Aero 2’s 30+ hour battery and comfort, but say its noise cancelling is weaker than the old model on planes, and a few report the left ear cutting out after a firmware update (a fix ships next week). At the new $149 price it’s a good buy if battery and comfort matter more to you than flight noise.',
  'TL;DR of a research abstract':
    'A 20-minute walk after lunch helped office workers fall asleep 11 minutes faster and wake 18% less often over 8 weeks. They didn’t sleep longer overall, and walking outdoors helped most.',
  'Summarise a long customer email': [
    'Desk delivered on the 9th with a cracked leg; two promised replacement parts never arrived.',
    'Wants the leg by Friday or a full refund including the $35 delivery fee.',
    'Says they will post a review, so this is urgent.',
  ].join('\n'),
  'Translate a café menu into Spanish':
    'Flat white – $4.20. Leche de avena +$0.60. Pan de plátano tostado con mantequilla salada – $3.80. Sopa del día: tomate asado y pimiento rojo – $6.50. Pregúntanos por nuestras opciones sin gluten.',
  'French version of an app store description':
    'Plantpal vous rappelle quand arroser chaque plante, selon l’espèce, la saison et la météo près de chez vous. Prenez une photo pour identifier une plante en quelques secondes. Fonctionne hors ligne. Sans publicité, pour toujours.',
  'Translate a legal notice into Portuguese':
    'Aviso de alteração dos termos. A partir de 1º de março, as contas inativas há mais de 24 meses serão encerradas após aviso prévio de 30 dias por e-mail. Saldos inferiores a US$ 1,00 serão doados à instituição de caridade indicada na seção 9. Você pode se opor respondendo a este aviso.',
  'Compare three project-management tools for a 5-person team': [
    '| Tool | 5 seats / month | Ease of use | Free tier |',
    '|---|---|---|---|',
    '| Board-style tool | ~$50 | Very easy | Yes, up to 10 users |',
    '| List + docs tool | ~$40 | Easy | Yes, limited storage |',
    '| Issue tracker | ~$45 | Steeper, built for engineers | Yes, up to 10 users |',
    '',
    'Recommendation: the board-style tool. Designers and engineers both pick it up in a day, and the free tier covers you until you hire.',
  ].join('\n'),
  'Find grants for a community garden': [
    '- City or county neighbourhood grants: tools, beds, water hookups. Typically $500–$5,000.',
    '- Community foundation small grants: programmes and outreach. $1,000–$10,000.',
    '- Food-security grants from regional food banks: produce for pantries, seeds. $500–$3,000.',
    '- Local business sponsorships: fencing, signage, events. $200–$2,000 in cash or in kind.',
  ].join('\n'),
  'Market snapshot: e-bike subscriptions': [
    'What’s included: the bike, servicing, theft insurance, and a swap if it breaks.',
    'Price: usually $40–$90 a month, with a 3–12 month minimum.',
    'Risks: theft and damage costs eat margins; churn spikes in winter.',
    'Where it took off: Amsterdam and Berlin, helped by dense cycling infrastructure.',
  ].join('\n'),
  'Clean up a messy contact list': [
    'name,email,phone,city',
    'Ada Obi,ada.obi@mail.com,+2348035550101,Lagos',
    'Tom Reyes,tom@reyes.io,+14155550199,San Francisco',
    'Mei Lin,,,',
    '',
    'Notes: merged two duplicates each for Ada and Tom; Mei Lin’s email is invalid and her phone has no country code, so both were left blank for you to confirm.',
  ].join('\n'),
  'Standardise product categories': [
    'sku,category',
    'A1,Kitchen',
    'A2,Garden',
    'A3,Office',
    'A4,Toys',
    'A5,Garden',
    'A6,Office',
  ].join('\n'),
  'Review a small login handler': [
    '1. SQL injection: the email goes straight into the query. Use a parameterised query.',
    '2. Passwords compared in plain text with ==. Store a slow hash (argon2/bcrypt) and compare with a constant-time check.',
    '3. The session cookie is the raw user id, so anyone can forge it. Use a random session token, httpOnly and secure.',
    '4. Failed logins return 500. Return 401 with a generic message, and rate-limit attempts.',
  ].join('\n'),
  'Check a pagination function': [
    '- `len(items) // size` undercounts pages when the last page is partial: use ceiling division.',
    '- Page numbering is zero-based; document it or accept page 1 as the first page.',
    '- Negative pages slice from the end of the list; reject page < 0.',
    '- size = 0 divides by zero; require size >= 1.',
  ].join('\n'),
  'Review a payment retry loop': [
    'Double charges come from retrying a call that may have succeeded: a timeout doesn’t mean the charge failed.',
    '- Send an idempotency key (the order id) with every attempt so the provider dedupes.',
    '- Only retry on errors the provider marks as safe to retry; check the charge status before retrying after a timeout.',
    '- Use exponential backoff, not a fixed 100ms, and stop after the last attempt with an explicit error (it currently returns undefined).',
  ].join('\n'),
  'Three taglines for a neighbourhood bakery': [
    '1. Fresh from 6am, made with care.',
    '2. Sourdough, cardamom, and a kind word.',
    '3. Your corner’s warmest hello.',
  ].join('\n'),
  'Rewrite a job ad to sound human':
    'We’re a 12-person furniture workshop looking for a part-time bookkeeper: about 20 hours a week, on a schedule that works for you. You’ll keep our books tidy so we can keep building. If you like numbers and the smell of sawdust, we’d love to hear from you.',
  'Translate a getting-started page into Yoruba':
    'Ṣẹ̀dá àkáǹtì kan láàrin ìṣẹ́jú kan. Orúkọ àkáǹtì rẹ jẹ́ tìrẹ títí láé. O lè fi owó ránṣẹ́ sí ẹnikẹ́ni tí ó ní orúkọ àkáǹtì, owó iṣẹ́ náà kò sì tó kọ́bọ̀ kan.',
  'Summarise a governance proposal for voters': [
    '- Moves 5% of the community treasury into a public-goods grant fund.',
    '- An elected committee of seven reviews grants every quarter and publishes each decision with reasons.',
    '- Grants over $10,000 need a second vote.',
    '- Concern: insiders could be favoured. Answer: published reasons and the second vote.',
  ].join('\n'),
  'Practice: one-line summary':
    'The 5th Street bakery will close for two weeks in August for renovations, then reopen with more seating and a new coffee bar.',
  'Practice: translate a greeting': 'Buenos días, la tienda abre a las nueve.',
  'Practice: list three facts': [
    '1. Mars is red because its soil is full of rusty iron.',
    '2. Olympus Mons on Mars is the tallest volcano in the solar system.',
    '3. A day on Mars is only 37 minutes longer than ours, and it has two tiny moons.',
  ].join('\n'),
  'Practice: fix the dates': '2026-03-14, 2026-03-14, 2026-03-14',
  'Practice: spot the bug':
    'Off-by-one: `i <= arr.length` reads one past the end, so the last step adds undefined and total becomes NaN. Use `i < arr.length`.',
  'Practice: a subject line': 'This weekend only: 20% off every winter coat',
  'Competitive brief: three note-taking apps': [
    'App A: free with paid sync ($8/mo); positioned for personal knowledge. Gap: weak team sharing.',
    'App B: $10/seat; positioned for teams and docs. Gap: slow offline mode.',
    'App C: $4/mo; positioned for speed and capture. Gap: no structure for long projects.',
    'Opening: a fast, offline-first tool with real team sharing.',
  ].join('\n'),
  'Review a Rust token transfer function': [
    '- Uses `signer_account_id`: use `predecessor_account_id`, or any contract the user calls can move their tokens.',
    '- `bal - amount` panics on underflow in debug and wraps in release with overflow checks off: use `checked_sub` and a clear error.',
    '- `to_bal + amount` can overflow: `checked_add`.',
    '- No check that `to` is registered, no event log, and no 1 yocto deposit requirement for an explicit signature.',
  ].join('\n'),
  'Localise onboarding emails into German': [
    'Willkommen an Bord',
    'Deine erste Woche, schon geplant',
    'Ein Tipp, der dir eine Stunde spart',
  ].join('\n'),
  'Summarise this article': [
    '- European cities are turning car lanes into protected bike lanes.',
    '- In Paris, bike trips doubled in two years, and shops on converted streets say sales held or grew.',
    '- Critics point to lost loading space for deliveries and traffic pushed onto side streets.',
  ].join('\n'),
  'Translate a birthday message':
    'Buon compleanno, Nonna! Ci manchi tanto e non vediamo l’ora di venirti a trovare quest’estate. Tienici da parte un po’ della tua lasagna.',
  'Three cheap weekend trips from my city': [
    '1. A coastal town 1–2 hours away by regional train: off-season guesthouses run about $60 a night; walk the seafront, eat at the harbour. Around $150 all in.',
    '2. A national park with a station nearby: hostel or campsite, two days of trails. Around $90.',
    '3. A smaller historic city: free walking tour, markets, one museum. Around $120 with a budget hotel.',
    'Book trains two weeks ahead and travel Saturday morning to Sunday evening for the cheapest fares.',
  ].join('\n'),
  'Name my podcast': [
    '1. Night Shift Notes',
    '2. Scrubs After Dark',
    '3. The 3am Round',
    '4. Two Nurses, One Coffee',
    '5. Handover',
    'Best pick: "Handover". Every shift ends with one, and every episode is two nurses handing over what the night taught them.',
  ].join('\n'),
};
