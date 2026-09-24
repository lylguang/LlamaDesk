# 任务 29 返工：第 6 条用例没真的钉住「只对 bash 降级」

源码不用改，主体是对的。只改 `apps/studio/src/bun/permissions.test.ts` 里你新加的第 6 条用例。

## 问题

第 6 条现在是：

```
expect(evaluate({ permission: "edit", pattern: "src/a.ts" }, rules).action).toBe("allow");
```

验收时做定点变异——**把降级条件里的 `request.permission === "bash" &&` 整个删掉**（也就是让所有权限都参与降级）——这 6 条用例**全绿**。

原因：`src/a.ts` 本身不是危险命令，`isDangerousCommand("src/a.ts")` 返回 false，所以就算不限定 bash，这条也不会被降级。这条用例证明的是「不危险的东西不降级」，不是「非 bash 不降级」。

## 改成这样

让第 6 条用一个**本身就会被判定为危险命令的字符串**当 pattern，配一条通配的 allow 规则，权限用非 bash：

```
  test("只对 bash 降级：非 bash 权限即使 pattern 看起来像危险命令也照常放行", () => {
    const rules = [{ permission: "edit", pattern: "*", action: "allow" as const }];
    // 这串在 bash 下会被判危险；换成 edit 权限就不该走降级那条路。
    expect(evaluate({ permission: "edit", pattern: "rm -rf /tmp/x" }, rules).action).toBe("allow");
  });
```

pattern 用哪一串你自己定，前提是 `isDangerousCommand(它)` 为 true——可以先在用例里 `expect(isDangerousCommand(那串)).toBe(true)` 断言一句，把前提也钉住，这样将来危险清单变了这条用例会明确地红，而不是悄悄变成空转。

原来那条「不危险的东西不降级」如果你觉得有价值可以留着，另起一条，不要和新的这条合在一起。

## 自检

改完自己做一次同样的变异验证：把 `request.permission === "bash" &&` 删掉，**新的第 6 条必须变红**；改回来必须全绿。把两次输出贴进汇报第 2 节。

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/29-dangerous-under-wildcard.json
```

输出原样贴进汇报第 4 节。汇报按六节格式写。
