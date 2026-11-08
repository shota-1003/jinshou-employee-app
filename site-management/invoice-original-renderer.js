// Generated from jinshou-payables sales-invoice-print.ts and invoice-line-math.ts. No business data.
(function(){"use strict";
                                                                                                                                                                          
                                                                                                
const MAX = BigInt('99999999999999')
function decimal(value        , places        , label        , allowNegative = false)         {
  const text = String(value)
  const negative = allowNegative && text.startsWith('-')
  const body = negative ? text.slice(1) : text
  if (!new RegExp(`^\\d{1,14}(?:\\.\\d{1,${places}})?$`).test(body)) throw new Error(`${label}は${allowNegative ? '' : '0以上、'}小数点以下${places}桁以内で入力してください。`)
  const [whole, fraction = ''] = body.split('.')
  const result = BigInt(whole) * BigInt(10 ** places) + BigInt(fraction.padEnd(places, '0'))
  return negative ? -result : result
}
function money(value        )         {
  if (!Number.isSafeInteger(value) || value < 0 || BigInt(value) > MAX) throw new Error('元の売上金額を確認してください。')
  return BigInt(value)
}
// 単価・数量がどちらも空の行は「見出し行」(工事名など)で金額は0。調整費のようにマイナスの単価も入れられる。
const isHeadingLine = (line                                                      ) => !String(line.unit_price).trim()
function invoiceLineAmount(line                                                      )         {
  if (isHeadingLine(line)) return 0
  const price = decimal(line.unit_price, 2, '単価', true), quantity = decimal(line.quantity, 3, '数量')
  if (quantity === BigInt(0)) throw new Error('数量は0より大きい値を入力してください。')
  const negative = price < BigInt(0), abs = negative ? -price : price
  if (abs > MAX * BigInt(100) || quantity > BigInt(999999999)) throw new Error('単価または数量が大きすぎます。')
  const amount = (abs * quantity + BigInt(50000)) / BigInt(100000)
  if (amount > MAX) throw new Error('明細の金額が大きすぎます。')
  return negative ? -Number(amount) : Number(amount)
}
function calculateInvoiceLines(lines                       , sources                     , taxRate                       ) {
  if (!['10','8','exempt'].includes(taxRate)) throw new Error('税率を選んでください。')
  if (!lines.length || lines.length > 200) throw new Error('明細は1〜200行で入力してください。')
  const ids = new Set(sources.map(s => s.id))
  if (!ids.size || ids.size !== sources.length) throw new Error('元の売上を確認してください。')
  const totals = new Map               ()
  const calculated = lines.map(line => {
    if (!ids.has(line.source_sales_record_id)) throw new Error('明細の元になる売上を選んでください。')
    if (line.description.length > 2000 || line.unit.length > 20) throw new Error('品名と単位を確認してください。')
    if (line.service_date && (!/^\d{4}-\d{2}-\d{2}$/.test(line.service_date) || Number.isNaN(Date.parse(line.service_date)) || new Date(line.service_date).toISOString().slice(0,10) !== line.service_date)) throw new Error('明細の日付を確認してください。')
    const amount = invoiceLineAmount(line)
    totals.set(line.source_sales_record_id, (totals.get(line.source_sales_record_id) ?? BigInt(0)) + BigInt(amount))
    return {...line, amount_excl_tax: amount}
  })
  const source_totals = sources.map(source => {
    const amount = totals.get(source.id)
    if (amount === undefined) throw new Error('選択した売上ごとに明細を1行以上入れてください。')
    if (amount === BigInt(0)) throw new Error('売上ごとの明細合計は0円より大きい金額にしてください。')
    if (amount > MAX) throw new Error('売上の合計が大きすぎます。')
    const previous = money(source.amount_excl_tax), previousIncl = money(source.amount_incl_tax)
    const expectedTax = taxRate === 'exempt' ? BigInt(0) : (amount * BigInt(taxRate) + BigInt(50)) / BigInt(100)
    const tax = amount === previous ? previousIncl - previous : expectedTax
    const delta = tax > expectedTax ? tax - expectedTax : expectedTax - tax
    if (tax < BigInt(0) || (amount === previous && (delta > BigInt(1) || (taxRate === 'exempt' && tax !== BigInt(0))))) throw new Error('税率と元の売上金額が一致しません。税率を確認してください。')
    const incl = amount + tax
    if (incl > MAX) throw new Error('税込合計が大きすぎます。')
    return {sales_record_id:source.id,amount_excl_tax:Number(amount),amount_incl_tax:Number(incl),tax_amount:Number(tax),previous_excl_tax:source.amount_excl_tax,previous_incl_tax:source.amount_incl_tax,changed:amount!==previous||incl!==previousIncl}
  })
  const excl = source_totals.reduce((s,t)=>s+BigInt(t.amount_excl_tax),BigInt(0)), incl = source_totals.reduce((s,t)=>s+BigInt(t.amount_incl_tax),BigInt(0))
  if (incl > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('請求合計が大きすぎます。')
  return {lines:calculated,source_totals,amount_excl_tax:Number(excl),amount_incl_tax:Number(incl),tax_amount:Number(incl-excl),changed:source_totals.some(t=>t.changed)}
}

/** A4 layout based on the supplied invoice workbook; all business data is supplied per snapshot. */
                                      
                        
                   
                         
                        
                           
                     
              
                                  
                                  
                                                                                                                                  
                                                                                                                                                      
                  
                                                                                                                                                                                                    
 

const escapeHtml = (value        ) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] )

function cents(value                 )         {
  const text = String(value).trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(text) || (typeof value === 'number' && (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER))) {
    throw new Error('請求金額は0以上、小数点以下2桁以内の金額で確認してください。')
  }
  const [whole, decimal = ''] = text.split('.')
  return BigInt(whole) * BigInt(100) + BigInt(decimal.padEnd(2, '0'))
}

// 調整費などマイナスの明細行用。符号を外して0以上の変換を通し、符号を戻す。
function scents(value                 )         {
  const text = String(value).trim()
  return text.startsWith('-') ? -cents(text.slice(1)) : cents(value)
}

function yen(value        )         {
  if (value < BigInt(0)) return `-${yen(-value)}`
  const whole = value / BigInt(100)
  const fraction = String(value % BigInt(100)).padStart(2, '0').replace(/0+$/, '')
  return `${String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''} 円`
}

function date(value        )         {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : value
}

/** Only PNG data URLs may enter the document; remote and active image formats are rejected. */
function pngImage(value         )         {
  if (!value) return ''
  if (value.length > 2000000 || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('会社画像はPNG形式で登録してください。')
  }
  return value
}

/** Pure function: no browser APIs, external assets, scripts or network requests. */
function buildInvoiceHtml(input                        )         {
  const excl = cents(input.amount_excl_tax)
  const incl = cents(input.amount_incl_tax)
  if (incl < excl) throw new Error('税込金額が税抜金額を下回っています。金額を確認してください。')
  const e = escapeHtml
  const text = (value        ) => e(value) || '—'
  const recipient = input.recipient_name.trim()
  const addressedRecipient = /(?:御中|様|殿|各位)$/.test(recipient) ? recipient : `${recipient} 御中`
  const tax = incl - excl
  const logo = pngImage(input.issuer.logo_data_url)
  const seal = pngImage(input.issuer.seal_data_url)
  // A very tall table cell fragments inconsistently between browsers. Keep the full text in normal flow.
  const extended = input.description.length > 300 || input.description.split('\n').length > 5
  const description = extended ? '工事代金（請求内容の詳細は別記）' : input.description
  const items = input.items?.length ? input.items : [{ bill_date: input.issued_on, project_name: description, amount_excl_tax: input.amount_excl_tax, amount_incl_tax: input.amount_incl_tax }]
  if (!input.editable_lines && (items.reduce((total, item) => total + cents(item.amount_excl_tax), BigInt(0)) !== excl || items.reduce((total, item) => total + cents(item.amount_incl_tax), BigInt(0)) !== incl)) throw new Error('明細と請求合計が一致しません。')
  const edited = input.editable_lines
  const extendedLines                                         = []
  if (edited && (!edited.length || edited.length > 200 || edited.reduce((total, line) => total + scents(line.amount_excl_tax), BigInt(0)) !== excl)) throw new Error('明細と請求合計が一致しません。')
  const rows = edited ? edited.map((line, index) => {
    if (invoiceLineAmount(line) !== line.amount_excl_tax) throw new Error('明細の単価・数量と金額が一致しません。')
    const isLong = line.description.length > 300 || line.description.split('\n').length > 5
    if (isLong) extendedLines.push({index:index+1, description:line.description})
    return '<tr><td class="detail-date">' + e(line.service_date || '') + '</td><td class="copy">' + text(isLong ? '明細 ' + (index+1) + '（品名の詳細は別記）' : line.description) + '</td>' + (String(line.unit_price).trim() === '' ? '<td></td><td></td><td></td><td></td>' : '<td class="num">' + yen(scents(line.unit_price)) + '</td><td class="center">' + e(line.quantity) + '</td><td class="center">' + e(line.unit) + '</td><td class="num">' + yen(scents(line.amount_excl_tax)) + '</td>') + '</tr>'
  }).join('') : items.map(item => '<tr><td class="detail-date">' + e(item.bill_date) + '</td><td class="copy">' + text(items.length === 1 ? description : item.project_name || '工事代金') + '</td><td class="num">' + yen(cents(item.amount_excl_tax)) + '</td><td class="center">1</td><td class="center">式</td><td class="num">' + yen(cents(item.amount_excl_tax)) + '</td></tr>').join('')
  const blankRows = Array.from({ length: Math.max(0, 25 - (edited?.length ?? items.length)) }, () => '<tr class="blank"><td></td><td></td><td></td><td></td><td></td><td></td></tr>').join('')
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; base-uri 'none'; form-action 'none'">
<title>請求書 ${e(input.invoice_number)}</title>
<style>
@page{size:A4 portrait;margin:8mm 11mm 10mm}
*{box-sizing:border-box}html{background:#fff;color:#111;font-family:"Yu Gothic",Meiryo,sans-serif;font-size:9pt;line-height:1.4;print-color-adjust:exact;-webkit-print-color-adjust:exact}body{margin:0}main{max-width:188mm;margin:auto}.copy{white-space:pre-wrap;overflow-wrap:anywhere}.head{position:relative;min-height:75mm;display:grid;grid-template-columns:1fr 62mm;gap:8mm;align-items:start}.address-block{position:absolute;left:19mm;top:17mm;width:90mm;font-size:11pt;line-height:1.3}.recipient{font-size:12pt;font-weight:600;margin-top:3mm}.recipient-address{min-height:9mm}.meta{text-align:right;font-size:8pt;margin-bottom:3mm}.issuer{position:relative;isolation:isolate;min-height:48mm;font-size:8.5pt}.issuer-name{font-size:12pt;font-weight:700;margin:2mm 0}.logo{position:absolute;z-index:-1;inset:0 auto auto 0;width:52mm;height:40mm;object-fit:contain;opacity:.2}.seal{display:block;width:22mm;height:20mm;object-fit:contain;margin:2mm 4mm 0 auto}.title{color:#1508b8;font-size:30pt;letter-spacing:.22em;text-align:center;position:absolute;left:0;right:0;top:58mm;margin:0;font-weight:700}.lead{margin:3mm 0 5mm;white-space:pre-line}.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));text-align:center;margin-bottom:5mm;break-inside:avoid}.summary>div{border:1px solid #1508b8}.summary>div+div{border-left:0}.summary-label{color:white;background:#1508b8;padding:1mm}.summary-value{padding:2mm 1mm;font-size:17pt;font-weight:700;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.items{width:100%;border-collapse:collapse;table-layout:fixed;font-size:9pt}.items th{color:#fff;background:#1508b8;font-weight:400}.items td,.items th{border:1px solid #1508b8;padding:.6mm 1mm;vertical-align:top;overflow-wrap:anywhere}.items thead{display:table-header-group}.items tr{break-inside:avoid}.items .blank{height:5mm}.num{text-align:right}.center{text-align:center}.bank{margin-top:4mm;break-inside:avoid}.bank h2{margin:0;background:#1508b8;color:white;font-weight:400;font-size:9pt;padding:1mm}.bank p{margin:0;padding:1mm 0;border-bottom:1px solid #1508b8;font-size:9pt}.extra{margin-top:4mm}.extra h2{font-size:10pt;color:#1508b8;border-bottom:1px solid #1508b8;break-after:avoid;margin:0 0 2mm}.extra p{margin:0;orphans:3;widows:3}.due{font-size:8pt;margin:2mm 0}.detail-date{font-size:7.5pt}
@media screen{body{padding:8mm 11mm 10mm}}@media print{a{color:inherit;text-decoration:none}}
</style></head><body><main>
<header class="head"><div><div class="address-block"><div class="recipient-address copy">${e(input.recipient_address)}</div><div class="recipient copy">${text(addressedRecipient)}</div></div><h1 class="title">請 求 書</h1></div><div><div class="meta copy">${text(date(input.issued_on))}\n請求書番号：${text(input.invoice_number)}</div><div class="issuer">${logo ? `<img class="logo" src="${logo}" alt="">` : ''}<div class="copy">${text(input.issuer.address)}</div><div class="issuer-name copy">${text(input.issuer.name)}</div>${input.issuer.representative ? `<div class="copy">${e(input.issuer.representative)}</div>` : ''}${input.issuer.phone ? `<div class="copy">TEL：${e(input.issuer.phone)}</div>` : ''}${input.issuer.fax ? `<div class="copy">FAX：${e(input.issuer.fax)}</div>` : ''}${input.issuer.registration_number ? `<div class="copy">登録番号：${e(input.issuer.registration_number)}</div>` : ''}${seal ? `<img class="seal" src="${seal}" alt="社印">` : ''}</div></div></header>
<p class="lead">平素は格別のご高配を賜り、厚く御礼申し上げます。
下記の通り、ご確認下さいますようお願い申し上げます。</p>
<div class="summary"><div><div class="summary-label">税抜合計</div><div class="summary-value">${yen(excl)}</div></div><div><div class="summary-label">税額${input.tax_rate ? `（${e(input.tax_rate)}）` : ''}</div><div class="summary-value">${yen(tax)}</div></div><div><div class="summary-label">税込合計</div><div class="summary-value">${yen(incl)}</div></div></div>
<table class="items" aria-label="請求明細"><colgroup><col style="width:12%"><col style="width:43%"><col style="width:15%"><col style="width:7%"><col style="width:7%"><col style="width:16%"></colgroup><thead><tr><th>日付</th><th>品名</th><th>単価</th><th>数量</th><th>単位</th><th>金額</th></tr></thead><tbody>${rows}${blankRows}</tbody></table>
<section class="bank"><h2>＊ お振込みの際は、下記口座までお願い致します。</h2><p class="copy">${text(input.issuer.bank_details)}</p></section>
${input.due_date ? `<p class="due">お支払期限：${e(date(input.due_date))}</p>` : ''}
${!edited && extended && items.length === 1 ? `<section class="extra"><h2>請求内容（別記）</h2><p class="copy">${e(input.description)}</p></section>` : ''}
${extendedLines.map(line => `<section class="extra"><h2>明細 ${line.index}（品名の詳細）</h2><p class="copy">${e(line.description)}</p></section>`).join('')}
${input.note ? `<section class="extra"><h2>備考</h2><p class="copy">${e(input.note)}</p></section>` : ''}
</main></body></html>`
}


window.SiteInvoicePrint={buildInvoiceHtml};
})();
