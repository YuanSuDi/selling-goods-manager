'use strict'

// 腾讯文档 MCP（https://docs.qq.com/openapi/mcp）の最小クライアント。
// 認証は Bearer トークン（ユーザーが同期画面で入力し、端末内にのみ保存）。
// プロトコルは Python 製コネクタクライアントで検証済みの形に合わせる:
// initialize → notifications/initialized、Mcp-Session-Id ヘッダ、
// レスポンスは application/json か text/event-stream のどちらか。

const https = require('https')

const ENDPOINT = 'https://docs.qq.com/openapi/mcp'
const PROTOCOL = '2025-11-25'

class TdocClient {
  constructor(token) {
    this.token = String(token || '').trim()
    this.session = null
    this.seq = 0
    this.ready = false
  }

  request(method, params, notification) {
    return new Promise((resolve, reject) => {
      this.seq += 1
      const id = notification ? null : this.seq
      const body = { jsonrpc: '2.0', method, params: params || {} }
      if (id != null) body.id = id
      const payload = Buffer.from(JSON.stringify(body), 'utf8')
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL,
        'Content-Length': payload.length,
      }
      if (this.token) headers.Authorization = 'Bearer ' + this.token
      if (this.session) headers['Mcp-Session-Id'] = this.session
      const req = https.request(
        ENDPOINT,
        { method: 'POST', headers, timeout: 45000 },
        (res) => {
          const sid = res.headers['mcp-session-id']
          if (sid) this.session = sid
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            if (notification) {
              if (res.statusCode === 202 || res.statusCode === 200) return resolve(null)
              return reject(new Error('MCP 初期化通知が受理されませんでした (HTTP ' + res.statusCode + ')'))
            }
            if (res.statusCode !== 200) {
              return reject(new Error('腾讯文档 API HTTP ' + res.statusCode))
            }
            try {
              resolve(this.decode(text, res.headers['content-type'] || '', id))
            } catch (e) {
              reject(e)
            }
          })
        }
      )
      req.on('timeout', () => req.destroy(new Error('腾讯文档 API タイムアウト')))
      req.on('error', (e) => reject(new Error('腾讯文档 API へ接続できません: ' + e.message)))
      req.write(payload)
      req.end()
    })
  }

  decode(text, contentType, id) {
    let message = null
    if (contentType.includes('text/event-stream')) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue
        try {
          const m = JSON.parse(line.slice(5).trim())
          if (m && m.id === id) message = m
        } catch (e) { /* 壊れた行は無視 */ }
      }
    } else {
      message = JSON.parse(text)
    }
    if (!message || typeof message !== 'object') throw new Error('腾讯文档 API の応答が不正です')
    if (message.error) {
      throw new Error('腾讯文档 API エラー: ' + JSON.stringify(message.error).slice(0, 300))
    }
    if (!message.result || typeof message.result !== 'object') {
      throw new Error('腾讯文档 API から結果が返りませんでした')
    }
    return message.result
  }

  async initialize() {
    if (this.ready) return
    await this.request('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'selling-goods-manager', version: '0.3.0' },
    })
    await this.request('notifications/initialized', {}, true)
    this.ready = true
  }

  async callTool(name, args) {
    await this.initialize()
    const result = await this.request('tools/call', { name, arguments: args || {} })
    if (result.isError) {
      let msg = 'ツール呼び出しに失敗しました'
      try {
        msg = (result.content && result.content[0] && result.content[0].text) || msg
      } catch (e) { /* noop */ }
      throw new Error(name + ': ' + String(msg).slice(0, 300))
    }
    if (result.structuredContent && typeof result.structuredContent === 'object') {
      return result.structuredContent
    }
    const text = result.content && result.content[0] && result.content[0].text
    if (text) {
      try {
        return JSON.parse(text)
      } catch (e) { /* テキストのまま返す */ }
    }
    return result
  }
}

module.exports = { TdocClient }
