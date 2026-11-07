import { useState } from "react";
import type { BookSummary } from "../../../../shared/contracts.js";
import { CrystalCollection } from "./CrystalCollection.js";
import { crystalStyle, useCrystalAppearance, saveCrystalAppearance, type CrystalAppearance } from "./crystal-preferences.js";
const colors = [["冰蓝", "#95ddff"], ["月白", "#e6efff"], ["淡紫", "#bba6ff"], ["玫瑰", "#f7adc9"], ["青碧", "#93ead5"]];
export function CrystalAppearanceSettings({ collectionId, books = [] }: { collectionId?: string; books?: BookSummary[] }) {
  const { appearance, custom } = useCrystalAppearance(collectionId);
  const [error, setError] = useState("");
  function save(value: CrystalAppearance | null) { try { saveCrystalAppearance(value, collectionId); setError(""); } catch { setError("配色未能保存，请重试。"); } }
  return <section className="crystal-settings" aria-label="水晶珍藏配色" style={crystalStyle(appearance)}>
    <h2>{collectionId ? "这份珍藏的配色" : "水晶珍藏"}</h2>
    <p>{collectionId ? custom ? "当前使用独立配色。" : "当前跟随全局配色，调整后会为这份珍藏单独保存。" : "设置珍藏页的水晶与光脉颜色。各珍藏也可在详情页单独配色。"}</p>
    <div className="crystal-settings-layout"><div className="crystal-settings-controls">
    <div className="crystal-swatches">{colors.map(([label, color]) => <button key={color} type="button" aria-label={label} aria-pressed={appearance.color === color} style={{ background: color }} onClick={() => save({ ...appearance, color })} />)}<label>自定义颜色<input type="color" aria-label="水晶颜色" value={appearance.color} onChange={e => save({ ...appearance, color: e.target.value })} /></label></div>
    <label className="crystal-slider">水晶色浓度<input type="range" min="0" max="100" value={Math.round(appearance.strength * 100)} onChange={e => save({ ...appearance, strength: Number(e.target.value) / 100 })} /><output>{Math.round(appearance.strength * 100)}%</output></label>
    <label className="crystal-slider">封面染色程度<input type="range" min="0" max="40" value={Math.round(appearance.tint * 100)} onChange={e => save({ ...appearance, tint: Number(e.target.value) / 100 })} /><output>{Math.round(appearance.tint * 100)}%</output></label>
    <button className="text-action" type="button" onClick={() => save(null)}>{collectionId ? "恢复跟随全局" : "恢复默认配色"}</button>
    {error && <p role="alert">{error}</p>}
    </div><div className="crystal-settings-preview"><CrystalCollection collection={{ id: collectionId ?? "crystal-preview", name: "配色预览", bookCount: books.length, previewBooks: books.slice(0,3), updatedAt: "preview" }} onSelect={() => undefined} previewAppearance={appearance} /></div></div>
  </section>;
}
