import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/index.css'
import AppHost from '@/components/apps/AppHost'
import CalendarApp from '@/components/apps/CalendarApp'
import { APP_MANIFEST } from '@/components/apps/manifest'

const meta = APP_MANIFEST.find((m) => m.id === 'calendar')!

function goBack() {
  if (window.history.length > 1) {
    window.history.back()
  } else {
    location.href = '../../index.html'
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className="fixed inset-0 bg-gradient-to-br from-sky-900 via-indigo-900 to-violet-900">
      <AppHost
        name={meta.name}
        description={meta.description}
        accent={meta.accent}
        icon={meta.icon}
        component={CalendarApp}
        onBack={goBack}
      />
    </div>
  </StrictMode>,
)
