import type { ReactNode } from 'react';
import { Button, Image, Input, Picker, Text, View } from '@tarojs/components';
import { art } from '../../assets';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <View className={`card ${className}`}>{children}</View>;
}
export function Heading({ title, titleImage, action, onClick }: { title: string; titleImage?: string; action?: string; onClick?: () => void }) {
  return <View className="section-heading">{titleImage ? <Image className="section-title-image" src={titleImage} mode="aspectFit" /> : <Text className="section-title">{title}</Text>}{action && <Button className="link-button" onClick={onClick}>{action} ›</Button>}</View>;
}
export function Coin({ amount }: { amount: number | string }) {
  return <View className="coin-number"><Text>{amount}</Text><Image src={art.coin} mode="aspectFit" /></View>;
}
export function Primary({ children, onClick, disabled = false, secondary = false }: { children: ReactNode; onClick: () => void; disabled?: boolean; secondary?: boolean }) {
  return <Button className={`action-button ${secondary ? 'secondary' : 'primary'} ${disabled ? 'is-disabled' : ''}`} disabled={disabled} onClick={onClick}>{children}</Button>;
}
export function Empty({ title, text, action, onClick }: { title: string; text: string; action?: string; onClick?: () => void }) {
  return <View className="empty"><Image src={art.robot} mode="aspectFit" /><Text className="empty-title">{title}</Text><Text className="muted empty-text">{text}</Text>{action && onClick && <Primary onClick={onClick}>{action}</Primary>}</View>;
}
export function Row({ label, value, onClick }: { label: string; value?: string; onClick?: () => void }) {
  return <Button className="menu-row" onClick={onClick} disabled={!onClick}><Text>{label}</Text><View className="row-value"><Text>{value}</Text>{onClick && <Text className="chevron">›</Text>}</View></Button>;
}
export function Field({ label, value, onChange, placeholder, maxLength = 50, numeric = false, password = false }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; maxLength?: number; numeric?: boolean; password?: boolean }) {
  return <View className="form-field"><Text className="field-label">{label}</Text><Input value={value} type={numeric ? 'digit' : 'text'} password={password} maxlength={maxLength} placeholder={placeholder} onInput={e => onChange(e.detail.value)} /></View>;
}
export function Choice({ label, values, value, onChange }: { label: string; values: string[]; value: string; onChange: (v: string) => void }) {
  return <View className="form-field"><Text className="field-label">{label}</Text><View className="choice-group">{values.map(item => <Button key={item} className={`choice ${value === item ? 'selected' : ''}`} onClick={() => onChange(item)}>{item}</Button>)}</View></View>;
}
export function Selector({ label, values, value, onChange }: { label: string; values: string[]; value: string; onChange: (v: string) => void }) {
  return <Picker mode="selector" range={values} value={Math.max(0, values.indexOf(value))} onChange={e => onChange(values[Number(e.detail.value)])}><View className="picker-row"><Text>{label}</Text><Text>{value} ›</Text></View></Picker>;
}
export function Toggle({ label, enabled, onChange, note }: { label: string; enabled: boolean; onChange: (v: boolean) => void; note?: string }) {
  return <Button className="toggle-row" onClick={() => onChange(!enabled)}><View><Text>{label}</Text>{note && <Text className="muted toggle-note">{note}</Text>}</View><View className={`toggle ${enabled ? 'on' : ''}`}><View /></View></Button>;
}
export function Counter({ label, value, setValue, min, max }: { label: string; value: number; setValue: (v: number) => void; min: number; max: number }) {
  return <View className="counter-row"><Text>{label}</Text><View className="counter-control"><Button disabled={value <= min} onClick={() => setValue(value - 1)}>−</Button><Input type="number" value={String(value)} onInput={e => { const n = Number(e.detail.value); if (Number.isInteger(n)) setValue(Math.max(min, Math.min(max, n))); }} /><Button disabled={value >= max} onClick={() => setValue(value + 1)}>＋</Button></View></View>;
}
