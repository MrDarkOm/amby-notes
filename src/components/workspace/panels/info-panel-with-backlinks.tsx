import { InfoPanel, type PanelRenderProps } from "../panel-registry"
import { useBacklinkCount } from "../use-link-graph-store"

/** The Info panel counts backlinks itself, so a new link graph re-renders only this panel. */
export function InfoPanelWithBacklinks(props: PanelRenderProps) {
  const properties = props.properties
  const backlinks = useBacklinkCount(properties?.kind === "folder" ? null : properties?.id)
  const merged =
    properties && properties.kind !== "folder" && properties.backlinks !== backlinks
      ? { ...properties, backlinks }
      : properties
  return <InfoPanel {...props} properties={merged} />
}
