import { useState } from 'react'
import { Search } from 'lucide-react'

interface SearchBarProps {
  searchEngine: string
}

const SEARCH_ENGINES: Record<string, { name: string; url: string; placeholder: string }> = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=', placeholder: 'Google Search' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=', placeholder: 'Bing Search' },
  baidu: { name: 'Baidu', url: 'https://www.baidu.com/s?wd=', placeholder: 'Baidu Search' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=', placeholder: 'DuckDuckGo Search' },
}

export default function SearchBar({ searchEngine }: SearchBarProps) {
  const [query, setQuery] = useState('')
  const [currentEngine, setCurrentEngine] = useState(searchEngine)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return

    const engine = SEARCH_ENGINES[currentEngine] || SEARCH_ENGINES.google
    window.open(engine.url + encodeURIComponent(query.trim()), '_blank')
    setQuery('')
  }

  const cycleEngine = () => {
    const engines = Object.keys(SEARCH_ENGINES)
    const currentIndex = engines.indexOf(currentEngine)
    const nextIndex = (currentIndex + 1) % engines.length
    setCurrentEngine(engines[nextIndex])
  }

  const engine = SEARCH_ENGINES[currentEngine] || SEARCH_ENGINES.google

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-xl mx-auto">
      <div className="relative group">
        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-white/40 group-focus-within:text-white/70 transition-colors">
          <Search className="w-4 h-4" />
        </div>
        <button
          type="button"
          onClick={cycleEngine}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-white/40 hover:text-white/70 bg-white/10 hover:bg-white/20 px-2 py-0.5 rounded transition-all"
          title="Switch search engine"
        >
          {engine.name}
        </button>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={engine.placeholder}
          className="w-full h-10 pl-11 pr-16 bg-white/10 backdrop-blur-sm border border-white/20 rounded-full text-white placeholder:text-white/40 focus:outline-none focus:bg-white/15 focus:border-white/30 transition-all text-sm"
        />
      </div>
    </form>
  )
}
