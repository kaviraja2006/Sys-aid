/**
 * Convert React Flow graph (nodes + edges) to Mermaid.js syntax (graph TD)
 * Maps systemType to Mermaid node shapes for visual consistency
 */

export function convertGraphToMermaid(nodes, edges) {
  if (!nodes || nodes.length === 0) {
    return 'graph TD\n    A["No nodes to export"]';
  }

  // Map systemType to Mermaid node shape
  const getNodeShape = (systemType) => {
    switch (systemType) {
      case 'database':
        return 'DATABASE'; // Cylinder shape: [(label)]
      case 'client':
        return 'CLIENT'; // Circle shape: ([label])
      case 'server':
      case 'cache':
      case 'cloud':
      case 'queue':
      case 'default':
      default:
        return 'BOX'; // Rectangle: [label]
    }
  };

  // Start with Mermaid graph declaration
  let mermaidCode = 'graph TD\n';

  // Add node declarations with shapes
  nodes.forEach((node) => {
    const nodeId = node.id.replace(/[^a-zA-Z0-9_]/g, '_'); // Sanitize ID for Mermaid
    const label = node.data?.label || node.id;
    const systemType = node.data?.systemType || 'default';
    const shape = getNodeShape(systemType);

    let shapedNode = '';
    switch (shape) {
      case 'DATABASE':
        shapedNode = `    ${nodeId}[("${label}")]`;
        break;
      case 'CLIENT':
        shapedNode = `    ${nodeId}(["${label}"])`;
        break;
      case 'BOX':
      default:
        shapedNode = `    ${nodeId}["${label}"]`;
    }

    mermaidCode += shapedNode + '\n';
  });

  // Add edge connections
  edges.forEach((edge) => {
    const sourceId = edge.source.replace(/[^a-zA-Z0-9_]/g, '_');
    const targetId = edge.target.replace(/[^a-zA-Z0-9_]/g, '_');
    const label = edge.label ? ` |${edge.label}|` : '';

    mermaidCode += `    ${sourceId} -->${label} ${targetId}\n`;
  });

  return mermaidCode.trim();
}

/**
 * Copy Mermaid syntax to clipboard and show feedback
 */
export async function copyMermaidToClipboard(nodes, edges) {
  try {
    const mermaidCode = convertGraphToMermaid(nodes, edges);
    await navigator.clipboard.writeText(mermaidCode);
    return { success: true, message: 'Copied to clipboard! Paste at https://mermaid.live' };
  } catch (err) {
    console.error('Failed to copy:', err);
    return { success: false, message: 'Failed to copy to clipboard' };
  }
}
