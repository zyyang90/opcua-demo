import pkg from "node-opcua";
const { OPCUAServer, Variant, DataType, StatusCodes, LocalizedText } = pkg;

(async () => {
  const server = new OPCUAServer({
    port: 4840,
    resourcePath: "/UA/AeServer",
    buildInfo: { productName: "AE Demo Server" }
  });
  await server.initialize();

  const addressSpace = server.engine.addressSpace;
  const namespace = addressSpace.getOwnNamespace();

  // 1. 一个被监控的浮点变量
  let level = 0;
  const tank = namespace.addObject({
    organizedBy: addressSpace.rootFolder.objects,
    browseName: "Tank",
    eventSourceOf: addressSpace.rootFolder.objects.server,
    eventNotifier: 1
  });
  const levelVar = namespace.addAnalogDataItem({
    componentOf: tank,
    browseName: "Level",
    engineeringUnitsRange: { low: 0, high: 100 },
    dataType: "Double",
    value: { get: () => new Variant({ dataType: DataType.Double, value: level }) }
  });

  // 2. 关联一个 ExclusiveLevelAlarm（自动驱动状态机）
  const alarm = namespace.instantiateExclusiveLimitAlarm("ExclusiveLevelAlarmType", {
    componentOf: tank,
    browseName: "LevelAlarm",
    conditionSource: tank,
    inputNode: levelVar,
    highHighLimit: 90,
    highLimit: 70,
    lowLimit: 30,
    lowLowLimit: 10,
    severity: 500,
    optionals: ["ConfirmedState", "Confirm"]
  });
  alarm.setEnabledState(true);

  // 3. 让 level 周期性穿越阈值
  setInterval(() => {
    level = Math.round(50 + 50 * Math.sin(Date.now() / 3000));
    levelVar.setValueFromSource({ dataType: DataType.Double, value: level });
  }, 1000);

  // 4. 一个普通 Event（无状态、瞬时）：模拟"门被打开"
  //    自定义 EventType，继承 BaseEventType
  const doorOpenedEventType = namespace.addEventType({
    browseName: "DoorOpenedEventType",
    subtypeOf: "BaseEventType"
  });
  // 给事件类型加一个自定义属性：UserName
  namespace.addVariable({
    propertyOf: doorOpenedEventType,
    browseName: "UserName",
    dataType: "String",
    modellingRule: "Mandatory"
  });

  // 让 Server 节点能发事件源
  const serverObject = addressSpace.rootFolder.objects.server;

  // 每 5 秒触发一次 DoorOpened 事件
  let doorEventCount = 0;
  setInterval(() => {
    doorEventCount++;
    const userName = ["alice", "bob", "carol"][doorEventCount % 3];
    serverObject.raiseEvent(doorOpenedEventType, {
      message: { dataType: DataType.LocalizedText, value: new LocalizedText({ text: `Door opened by ${userName}` }) },
      severity: { dataType: DataType.UInt16, value: 100 },
      sourceName: { dataType: DataType.String, value: "FrontDoor" },
      userName: { dataType: DataType.String, value: userName }
    });
    console.log(`[Event] DoorOpened by ${userName}`);
  }, 5000);

  await server.start();
  console.log(`Server: ${server.getEndpointUrl()}`);
})();
