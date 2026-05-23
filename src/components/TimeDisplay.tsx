import { useState, useEffect } from 'react'

interface TimeDisplayProps {
  fontSize: number
  fontColor: string
  showSeconds: boolean
}

export default function TimeDisplay({ fontSize, fontColor, showSeconds }: TimeDisplayProps) {
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const interval = setInterval(() => {
      setTime(new Date())
    }, showSeconds ? 1000 : 60000)
    return () => clearInterval(interval)
  }, [showSeconds])

  const hours = time.getHours().toString().padStart(2, '0')
  const minutes = time.getMinutes().toString().padStart(2, '0')
  const seconds = time.getSeconds().toString().padStart(2, '0')

  const timeStr = showSeconds ? `${hours}:${minutes}:${seconds}` : `${hours}:${minutes}`

  const dateStr = time.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })

  return (
    <div className="text-center select-none">
      <div
        className="font-light tracking-wider transition-all duration-300"
        style={{ fontSize: `${fontSize}px`, color: fontColor }}
      >
        {timeStr}
      </div>
      <div
        className="mt-2 text-sm font-light tracking-wide"
        style={{ color: `${fontColor}99` }}
      >
        {dateStr}
      </div>
    </div>
  )
}
