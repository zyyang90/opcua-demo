import pkg from "node-opcua";
const {
  OPCUAClient,
  AttributeIds,
  TimestampsToReturn,
  ClientSubscription,
  ClientMonitoredItem,
  resolveNodeId,
  NodeId,
  MessageSecurityMode,
  SecurityPolicy,
  constructEventFilter,
} = pkg;

const endpointUrl = "opc.tcp://localhost:4840/UA/AeServer";

(async () => {
  const client = OPCUAClient.create({
    endpointMustExist: false,
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
  });
  await client.connect(endpointUrl);
  const session = await client.createSession();
  console.log(`Connected to ${endpointUrl}`);

  const subscription = ClientSubscription.create(session, {
    requestedPublishingInterval: 500,
    requestedMaxKeepAliveCount: 10,
    publishingEnabled: true,
  });

  // 用 EventFilter 订阅事件，指定要返回的事件字段
  const eventFields = [
    "EventId",
    "EventType",
    "SourceName",
    "Time",
    "Severity",
    "Message",
  ];
  const eventFilter = constructEventFilter(eventFields);

  // 订阅“事件源节点”的 EventNotifier 属性，获取事件通知
  const monitoredItem = ClientMonitoredItem.create(
    subscription,
    {
      nodeId: resolveNodeId("Server"),
      attributeId: AttributeIds.EventNotifier,
    },
    {
      samplingInterval: 0,
      discardOldest: true,
      queueSize: 100,
      filter: eventFilter,
    },
    TimestampsToReturn.Both,
  );

  // 服务端触发事件时，monitoredItem 会收到事件字段的值，触发 "changed" 事件
  monitoredItem.on("changed", (eventFields) => {
    const e = {};
    [
      "EventId",
      "EventType",
      "SourceName",
      "Time",
      "Severity",
      "Message",
    ].forEach((name, i) => {
      const v = eventFields[i];
      e[name] = v ? v.value : null;
    });
    const time = e.Time ? new Date(e.Time).toISOString().substring(11, 19) : "";
    const evtType = e.EventType ? e.EventType.toString() : "?";
    const msg = e.Message ? e.Message.text || e.Message : "";
    console.log(
      `[${time}] severity=${e.Severity} type=${evtType} source=${e.SourceName} msg="${msg}"`,
    );
  });

  console.log("Subscribed to events on Server. Press Ctrl+C to exit.");
})();
