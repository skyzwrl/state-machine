import { ServerStorage, Workspace } from "@rbxts/services";
import { attachBrain } from "./npc-brain";

// spawns ServerStorage.Npc, patrols the parts in Workspace.PatrolPoints in name order and respawns
// a few seconds after dying

const RESPAWN_DELAY = 5;

const template = ServerStorage.WaitForChild("Npc") as Model;
const waypoints = Workspace.WaitForChild("PatrolPoints")
	.GetChildren()
	.filter((point): point is BasePart => point.IsA("BasePart"))
	.sort((a, b) => a.Name < b.Name)
	.map((point) => point.Position);

function spawnNpc() {
	const npc = template.Clone();
	npc.Parent = Workspace;

	const detach = attachBrain(npc, waypoints);
	npc.FindFirstChildOfClass("Humanoid")?.Died.Once(() => {
		task.wait(RESPAWN_DELAY);
		detach();
		npc.Destroy();
		spawnNpc();
	});
}

spawnNpc();
