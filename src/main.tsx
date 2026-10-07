import { Component, StrictMode } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ASVA render error', error, info)
  }

  render() {
    if (this.state.error) {
      const errorCode = this.state.error.name || 'RENDER_ERROR'
      const debugText = JSON.stringify({ error_code: errorCode, message: this.state.error.message, release: 'UNKNOWN', page: window.location.pathname, time: new Date().toISOString() }, null, 2)
      return <main style={{ padding: 32, fontFamily: 'sans-serif', color: '#172033', maxWidth: 720, margin: '0 auto' }}><h1>工作台暂时无法打开</h1><p>页面遇到一个可恢复的错误。可以先刷新；如果仍然存在，请把下面的调试信息交给管理员。</p><p><strong>错误代码：</strong>{errorCode}</p><p><strong>版本：</strong>UNKNOWN（构建元数据未加载）</p><button type="button" onClick={() => window.location.reload()}>刷新页面</button>{navigator.clipboard && <button type="button" style={{ marginLeft: 8 }} onClick={() => void navigator.clipboard.writeText(debugText)}>复制安全调试信息</button>}<pre style={{ whiteSpace: 'pre-wrap', background: '#f6f7f9', padding: 16, marginTop: 20 }}>{debugText}</pre></main>
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </StrictMode>,
)
