import Fs from 'fs'
import Path from 'path'
import Dotenv from 'dotenv'
import { Configuration, OpenAIApi } from 'openai'
import { PDFExtract } from 'pdf.js-extract'

Dotenv.config()

const pdfsDir = './pdfs'
const outputDir = './output'

interface DocumentAttributes {
  type: string
  author: string
  date: string
  amount: number
  symbol: string
}

async function pdfToText(pdfFilePath: string) {
  const pdfExtract = new PDFExtract()
  const result = await pdfExtract.extract(pdfFilePath)

  const lines: string[] = []
  let line = ''

  for (const page of result.pages) {
    for (const content of page.content) {
      if (content.str === '') {
        lines.push(line)
        line = ''
      } else {
        line += content.str
      }
    }
  }

  if (line) lines.push(line)

  return lines.join('\n')
}

async function documentTextToAttributes(openai: OpenAIApi, text: string) {
  const prompt = `
  入力文は、PDF文書から抜き出したテキストです。これからこのPDF文章ファイル名を属性に基づいてリネームしてフォルダに分類します。
  そのために内容を解析し、属性を抽出します。
  
  入力文を読んで、次のプロパティを持つオブジェクトをJSON形式で出力してください。
  
  # オブジェクトのプロパティ仕様
  
  - type: 見積書・発注書・請求書・納品書・領収書・契約書・申込書などの種別。日本語に翻訳してください。
  - recipient: 宛先の会社名。ファイル名として不都合な文字は削除してください。
  - author: 発行元の会社名。ファイル名として不都合な文字は削除してください。
  - date: 発行日。YYYYMMDD形式で出力してください。
  - amount: 税抜の合計金額。数値として出力してください。
  - symbol: 通貨単位記号。JPYや¥は「円」、USDは「$」に統一してください。それ以外の通貨はそのまま出力してください。
  
  # 入力文
  
  ${text}
      `
  // console.log(prompt)

  const response = await openai.createChatCompletion({
    model: 'gpt-3.5-turbo',
    messages: [{ role: 'user', content: prompt }],
  })

  const reply = response.data.choices[0].message?.content || ''
  // console.log({ reply })

  let attributes: DocumentAttributes = {
    type: '不明',
    author: '?',
    date: '?',
    amount: 0,
    symbol: '?',
  }

  try {
    // 最初にレスポンスがJSONそのものを想定する
    attributes = JSON.parse(reply ?? '{}')
  } catch (error) {
    // 失敗した場合は、コードブロック内のJSONを抽出する
    try {
      if (reply.match(/```(.+?)```/s)) {
        attributes = JSON.parse(RegExp.$1)
      }
    } catch (error) {
      console.error({ text, error })
    }
  }

  return attributes
}

async function main() {
  const entries = Fs.readdirSync(pdfsDir, { withFileTypes: true })
  const pdfBasenames = entries
    .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.pdf'))
    .map((dirent) => dirent.name)

  const config = new Configuration({ apiKey: process.env.OPENAI_API_KEY })
  const openai = new OpenAIApi(config)

  const csv: string[][] = [['元のファイルパス', '種別', '発行元', '発行日', '金額', '通貨単位', '新しいファイル名']]
  for (const pdfBasename of pdfBasenames) {
    try {
      const path = Path.join('./pdfs', pdfBasename)
      const text = await pdfToText(path)

      const attrs = await documentTextToAttributes(openai, text)
      console.log({ pdfBasename, attrs })

      // 金額表記は日本円は数値+円、その他は記号+数値とする
      const price = attrs.symbol === '円' ? `${attrs.amount}${attrs.symbol}` : `${attrs.symbol}${attrs.amount}`

      const newBasename = `${attrs.date}_${attrs.author}_${price}_${attrs.type}.pdf`
      const newPath = Path.join(outputDir, attrs.type, newBasename)

      // CSVに行を追加
      csv.push([path, attrs.type, attrs.author, attrs.date, `${attrs.amount}`, attrs.symbol, newPath])

      // 別名でコピー
      Fs.mkdirSync(Path.dirname(newPath), { recursive: true })
      Fs.copyFileSync(path, newPath)
    } catch (error) {
      console.error({ pdfBasename, error })
    }
  }

  // CSVを出力
  Fs.mkdirSync(outputDir, { recursive: true })
  Fs.writeFileSync(
    Path.join(outputDir, '一覧.csv'),
    csv.map((row) => row.map((col) => `"${col.replace(/"/g, '""')}"`).join(',')).join('\n'),
  )
}

main()
