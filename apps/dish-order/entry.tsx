import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/index.css'
import AppHost from '@/components/apps/AppHost'
import DishOrderApp from '@/components/apps/DishOrderApp'
import { APP_MANIFEST } from '@/components/apps/manifest'

const meta = APP_MANIFEST.find((m) => m.id === 'dish-order')!

function goBack() {
  if (window.history.length > 1) {
    window.history.back()
  } else {
    location.href = '../../index.html'
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className="fixed inset-0 bg-gradient-to-br from-amber-900 via-orange-900 to-rose-900">
      <AppHost
        name={meta.name}
        description={meta.description}
        accent={meta.accent}
        icon={meta.icon}
        component={DishOrderApp}
        onBack={goBack}
      />
    </div>
  </StrictMode>,
)
