import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/index.css'
import AppHost from '@/components/apps/AppHost'
import GolfNavApp from '@/components/apps/golf-nav/GolfNavApp'
import { APP_MANIFEST } from '@/components/apps/manifest'

const meta = APP_MANIFEST.find((m) => m.id === 'golf-nav')!

function goBack() {
  if (window.history.length > 1) {
    window.history.back()
  } else {
    location.href = '../../index.html'
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className="fixed inset-0 bg-gradient-to-br from-slate-100 via-emerald-50 to-sky-100 text-slate-800">
      <AppHost
        theme="light"
        name={meta.name}
        description={meta.description}
        accent={meta.accent}
        icon={meta.icon}
        component={GolfNavApp}
        onBack={goBack}
      />
    </div>
  </StrictMode>,
)
