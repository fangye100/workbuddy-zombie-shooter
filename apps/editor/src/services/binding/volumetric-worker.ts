import { computeVolumetricWeights } from './volumetric-skin';
import type { BindingSession } from './binding-session';
type Input = Parameters<Parameters<BindingSession['computeSkinAsync']>[0]>[0];
const port = globalThis as unknown as { onmessage: ((event: MessageEvent<Input>) => void) | null; postMessage: (data: unknown, transfer?: Transferable[]) => void };
port.onmessage = ({ data }) => {
  try {
    const result = computeVolumetricWeights(data.vertices, data.stride, data.indices, data.placed, data.options);
    port.postMessage({ result }, [result.skin.joints.buffer, result.skin.weights.buffer]);
  } catch (error) { port.postMessage({ error: String(error) }); }
};
