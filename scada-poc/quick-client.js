// quick-client.js - 验证 simulate-scada 服务器
import pkg from "node-opcua";
const {
  OPCUAClient, AttributeIds, TimestampsToReturn,
  ClientSubscription, ClientMonitoredItem, resolveNodeId,
  MessageSecurityMode, SecurityPolicy,
} = pkg;

const url = process.argv[2] || "opc.tcp://127.0.0.1:64121//ScadaOpcUaServer";
const probes = [
  "ns=2;s=G1.ACK_PB",
  "ns=2;s=G1.ALM_PRESENT",
  "ns=2;s=CRM1_SVR.TempVariable0044",
  "ns=2;s=$User",
  "ns=2;s=CRM1_SVR.MajorRevision_R.EURange",
];

const client = OPCUAClient.create({
  endpointMustExist: false,
  securityMode: MessageSecurityMode.None,
  securityPolicy: SecurityPolicy.None,
});
await client.connect(url);
console.log(`[connect] ok -> ${url}`);
const session = await client.createSession();

for (const id of probes) {
  try {
    const dv = await session.read({ nodeId: id, attributeId: AttributeIds.Value });
    console.log(`  READ ${id} = ${JSON.stringify(dv.value?.value)} status=${dv.statusCode.toString()}`);
  } catch (e) {
    console.log(`  READ ${id} FAIL: ${e.message}`);
  }
}

const sub = ClientSubscription.create(session, {
  requestedPublishingInterval: 500,
  publishingEnabled: true,
});
const mi = ClientMonitoredItem.create(
  sub,
  { nodeId: "ns=2;s=CRM1_SVR.TempVariable0044", attributeId: AttributeIds.Value },
  { samplingInterval: 500, queueSize: 10, discardOldest: true },
  TimestampsToReturn.Both,
);
let count = 0;
mi.on("changed", (dv) => {
  console.log(`  SUB TempVariable0044 = ${dv.value?.value?.toFixed(3)}  @ ${dv.sourceTimestamp?.toISOString()}`);
  if (++count >= 3) {
    setTimeout(async () => { await session.close(); await client.disconnect(); process.exit(0); }, 100);
  }
});
