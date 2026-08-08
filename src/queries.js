// GraphQL operation strings — verified against the DCXV web app (src/lib/q.js) and
// real component usage, NOT the src/lib/api/*.md docs (those are inaccurate: they use
// `input:` where the real schema uses `inp:`). Do NOT add/remove fields ad hoc: the
// backend nulls the whole response when an unknown field is requested (see
// .claude/CLAUDE.md conventions).

// --- Account (userMy). Balance = `rest`; currency symbol = `sign`. can_pay = accepted
// payment methods (list of strings). Fields confirmed in UserFragment (q.js:3-42).
export const Q_ACCOUNT = `query {
  userMy { id fname lname email rest curr sign discount overdraft need_pay can_pay }
}`

// --- Full account profile for `dcxv account`. Only fields confirmed present on the
// User type (UserFragment, q.js:3-42) — requesting an unknown field nulls the whole
// response. `city`/`skype` are inpUserMod inputs but NOT UserFragment reads, so they
// are settable (M_USER_MOD) but intentionally omitted from this read query.
export const Q_ACCOUNT_FULL = `query {
  userMy {
    id fname lname email org id_country addr tel
    rest curr sign discount overdraft need_pay can_pay alias
    lng sshkey notify_bill
  }
}`

// --- Account data export (JSON blob). Scalar JSON. Confirmed Q_USER_DOWNLOAD (q.js:150),
// user-level (getUID; SDL/User.js:498).
export const Q_USER_DOWNLOAD = `query { userDownload }`

// --- Edit profile fields. inp: inpUserMod (every field optional; SDL/User.gql:52-73).
// Returns the updated User — selecting only UserFragment-confirmed fields (mail_invoice
// is an input-only field, so it is NOT read back here). Confirmed M_USER_MOD (q.js:75-82).
export const M_USER_MOD = `mutation($inp: inpUserMod) {
  userMod(inp: $inp) { id err fname lname org addr tel lng curr sshkey notify_bill }
}`

// --- Products list (order listing table). Fields confirmed in Q_MY productMy (q.js:103-137).
export const Q_PRODUCTS = `query {
  productMy {
    id vid type hostname os
    ip ips { ip mac ptr } mac
    active next_pay min_months price discount
    cpu cores ram hdd hdd2 hdd3 hdd4 bw ipcnt backup
    login pass autoprolong blocked blocked_reason intest
  }
}`

// --- Single-product detail (the "control panel" page). Confirmed Q_PRODUCT_ID
// (q.js:272-326) — matches src/routes/[[lang]]/my/orders/[sid]/+page.svelte exactly.
export const Q_PRODUCT_DETAIL = `query($id: Int!) {
  productId(id: $id) {
    id vid type created installed next_pay min_months active autoprolong
    blocked blocked_reason intest name cpu cores ram hdd hdd2 hdd3 hdd4 mobo
    bw ipcnt autoreboot ip ips { ip mac ptr } mac backup snaps hostname os iso
    client_notes login pass price discount smtp notify_emails notice_to_client
    pxe_install pxe_recovery ipmi meta admin_packet admin_used k8s k8sStatus k8sKubeconfig
  }
}`

// --- Live status/progress/resource poll. Confirmed Q_PRODUCT_MON (q.js:328-361).
// stat = JSON string { status, uptime, mem:[used,total], net:[in,out], disk:[used,total], cpu }.
export const Q_PRODUCT_MON = `query($id: Int!) {
  productMon(id: $id) {
    id installed next_pay hostname mac type login pass ip ips { ip mac ptr }
    blocked blocked_reason price stat progress
    cores hdd ram backup snaps ipcnt meta iso k8s k8sStatus k8sKubeconfig
  }
}`

// --- Resource usage history for charts. Confirmed Q_PRODUCT_GRAPH (q.js:363).
// Scalar JSON string; array of { time, cpu, mem, netin, netout, diskread, diskwrite, used }.
export const Q_PRODUCT_GRAPH = `query($id: Int!) { productGraph(id: $id) }`

// --- Available OS images for ordering. Public (no auth). Confirmed shape
// (id, name only — despite some api docs showing version/description, those
// don't exist on the real OS type; SDL/Product.gql:159-162) via dcxv-www's
// SelectOS.svelte / Calculators.svelte real usage.
export const Q_PRODUCT_OS = `query { productOS { id name } }`

// --- Cloud cluster/price-tier catalog for ordering. Public (no auth). Resolver
// (api-my SDL/Calc.js calcPrice) JSON.stringify()s the raw lib/calcPrice.js table, so
// the returned `calcPrice` field is a STRING that must be JSON.parse()d by the caller —
// it is not pre-parsed JSON despite the JSON scalar type. Same table dcxv-www's cluster
// dropdown reads (Calculators.svelte): filter type==='cloud' && sell, {value: vid, label: cpu}.
export const Q_CALC_PRICE_TABLE = `query { calcPrice }`

// --- Power / control / all other productSet-driven actions (rename, notify email,
// autoprolong, lock/unlock, renew, mac/ptr edit, password, upgrade, reinstall). inp:
// inpProdSet! ; cmd verbs confirmed in orders/[sid] page (START/STOP/SHUTDOWN/RESET/
// PASS/REINSTALL). Return fields confirmed at q.js:399-424.
export const M_PRODUCT_SET = `mutation($inp: inpProdSet!) {
  productSet(inp: $inp) {
    id err ret progress hostname notify_emails autoprolong autoreboot
    blocked blocked_reason next_pay price snaps client_notes
    ips { ip mac ptr } os iso k8s k8sStatus k8sKubeconfig
  }
}`

// Friendly verb -> backend cmd. No graceful "reboot" verb exists; restart/reboot map
// to RESET (hard reset), matching the web UI's control set.
export const CONTROLS = {
  start: 'START',
  stop: 'STOP',        // hard power off
  shutdown: 'SHUTDOWN', // graceful OS shutdown
  reset: 'RESET',      // hard reset
  restart: 'RESET',
  reboot: 'RESET',
  pass: 'PASS',        // reset password to initial
}

// --- Transactions. Confirmed Q_USER_TRANS (q.js:471-487). dt = epoch seconds.
export const Q_TRANSACTIONS = `query {
  userTrans { id dt reason info rest delta invoice txid confirms rate fee }
}`

// --- Single transaction detail — resolves a payment's link/QR. Confirmed
// Q_USER_TRANS_ID (q.js:489-513). url = payment link, qr = QR payload, total = amount due.
export const Q_TRANSACTION = `query($id: Int!) {
  userTransId(id: $id) {
    id dt reason info amount rest delta invoice
    txid confirms rate fee total url qr cc vat
  }
}`

// --- Generate / fetch a transaction's PDF invoice. Returns { id, pdf_url }. Confirmed
// M_USER_TRANS_ID_INVOICE (q.js:517), user-level (getUID; SDL/User.js:1182).
export const M_TRANS_INVOICE = `mutation($id: Int!) {
  userTransIdInvoice(id: $id) { id pdf_url }
}`

// --- Live product/task progress. S_PRODUCT from q.js:365 — streamed over ${url}/sse.
export const S_PRODUCT = `subscription {
  productSub { id stat progress err ret k8s k8sStatus k8sKubeconfig }
}`

// --- Payment. inp: inpUserPay! = { reason, amount }. Returns a scalar transaction id
// (Int > 0); resolve the link with Q_TRANSACTION. Confirmed M_USER_PAY (q.js:519) +
// PaymentOptions.svelte onPayQuery ({ reason, amount }).
export const M_USER_PAY = `mutation($inp: inpUserPay!) {
  userPay(inp: $inp)
}`

// --- Product order. inp: inpProdOrder! — large input; passed through from user flags.
// Return fields confirmed in M_PRODUCT_ORDER (q.js:523-573).
export const M_PRODUCT_ORDER = `mutation($inp: inpProdOrder!) {
  productOrder(inp: $inp) {
    id err ret type created installed next_pay min_months active
    hostname os cpu cores ram hdd bw ipcnt ip login pass price discount
  }
}`

// --- Price check (pure/read-only, no order created). Confirmed live against
// production: matches docs/NOTE_FOR_BACKEND_API.md section 10 exactly (implemented
// per that spec). Takes the same inpProdOrder! shape as productOrder.
export const Q_CALC_PRICE = `query($inp: inpProdOrder!) {
  productCalcPrice(inp: $inp) { price ok reason promo }
}`

// --- Product delete. Scalar return. Confirmed M_PRODUCT_REM (q.js:469). DESTRUCTIVE.
export const M_PRODUCT_REM = `mutation($id: Int!) { productRem(id: $id) }`

// --- Snapshots. Confirmed Q_PRODUCT_SNAP_LIST (q.js:369) / M_PRODUCT_SNAP_RESTORE (q.js:448).
export const Q_SNAP_LIST = `query($id: Int!) {
  productSnapList(id: $id) { name date description }
}`
export const M_SNAP_RESTORE = `mutation($id: Int!, $name: String!) {
  productSnapRestore(id: $id, name: $name) { id err ret progress }
}`

// --- Backups. Confirmed Q_PRODUCT_BACKUP_LIST (q.js:379) / M_PRODUCT_BACKUP_RESTORE (q.js:459).
export const Q_BACKUP_LIST = `query($id: Int!) {
  productBackupList(id: $id) { id date size }
}`
export const M_BACKUP_RESTORE = `mutation($id: Int!, $bid: Int!) {
  productBackupRestore(id: $id, bid: $bid) { id err ret }
}`

// --- Cloud ISO. Confirmed Q_PRODUCT_CLOUD_ISO_LIST (q.js:389), M_PRODUCT_CLOUD_ISO (q.js:426),
// M_PRODUCT_CLOUD_ISO_REM (q.js:439).
export const Q_ISO_LIST = `query($id: Int!) {
  productCloudISOList(id: $id) { id filename size expires_at ready }
}`
export const M_ISO_MOUNT = `mutation($id: Int!, $url: String!, $filename: String) {
  productCloudISO(id: $id, url: $url, filename: $filename) { id filename size expires_at ready err }
}`
export const M_ISO_REM = `mutation($id: Int!) {
  productCloudISORem(id: $id) { id err }
}`

// --- Sub-accounts. Confirmed q.js:152 / 174 / 185 / 196. Note userSubLogin id is Int!.
export const Q_SUB_ACCOUNTS = `query {
  userSubAccounts {
    id email fname rest last_login
    servers { id active name ip os created next_pay price }
  }
}`
export const M_SUB_ADD = `mutation($email: String!, $fname: String!) {
  userSubAdd(email: $email, fname: $fname) { id email id_parent err }
}`
export const M_SUB_LOGIN = `mutation($id: Int!) {
  userSubLogin(id: $id) { id email token err }
}`
export const M_SUB_EXIT = `mutation {
  userSubExit { id email token err }
}`

// --- Device-authorization login ("dcxv login", no token arg). cliAuthStart is public
// (no auth header sent); the CLI then opens an unauthenticated SSE subscription on
// cliAuthSub, filtered server-side by deviceCode, and receives exactly one push event
// once the user approves in the browser (see cli.js handleLoginDevice / client.js
// requestPublic+subscribePublic).
export const M_CLI_AUTH_START = `mutation($name: String) {
  cliAuthStart(name: $name) { deviceCode userCode verifyUrl expiresIn }
}`
export const S_CLI_AUTH = `subscription($deviceCode: String!) {
  cliAuthSub(deviceCode: $deviceCode) { status token }
}`
