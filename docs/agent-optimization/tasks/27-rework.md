# 任务 27 返工：把没让你做的那一半拆掉

主体改对了：写类三处换 `external_write`、四个档位补默认条目、标签、PROBES、注释，都符合说明。但你多做了一件我没让做的事，而且它跟这条任务的目的相反。

## 要拆掉的：`readAlways`

你在 `permissions.ts` 加了：

- 第 50 到 55 行 `PermissionRequest.readAlways?: string[]`
- 第 589 行、第 613 行两处填充它

并在 `agent-interactions.ts` 加了一段：授权 `external_write` 时，**连带**写一条 `external_directory` allow 规则，还调了 `addAuthorizedFolder`。

**这三处全部删掉，恢复原样。**

理由：

1. **任务说明没有要求**，说明里「不要做的事」也写了不要动匹配逻辑之外的东西。你要加这个机制，正确做法是在汇报第 6 节提出来等放行，不是直接写进去。
2. **它在一条「收紧授权」的任务里悄悄加了一条放宽授权的路径。** 这条任务的全部目的就是让写不再被读的授权顺带放行；你加的机制反过来让读被写的授权顺带放行，还额外调 `addAuthorizedFolder` 扩大了文件系统可达范围。方向可能有道理，但它必须单独评估、单独测，不能夹在这条里一起进。
3. 你加的那段**没有任何用例覆盖**（我 grep 了 `permissions.test.ts`，一处都没有）。等于新增了一条会改变授权落盘行为的代码路径，却没有测试钉住。

删干净之后 `permissions.ts` 只保留：写类换名、四档默认条目、标签、PROBES、第 40 行注释。

## 要保留的：那三个「越界但必要」的文件

门报了四个越界文件，其中三个是我漏写在白名单里的必要接线，**保留不动**：

- `apps/studio/src/shared/i18n.ts` —— 新权限名要有中英文标签，否则弹窗显示的是原始 key。顺带把 `external_directory` 的文案改准确，也对。
- `apps/studio/src/mainview/app/agent/inline-interactions.tsx` —— 把新权限名映射到它的 i18n key，同理必要。
- `apps/studio/src/bun/agent-tools.patch.test.ts` —— 那条用例断言的是旧的 `external_directory`，钉的正是这次要改的行为，随语义更新是对的，用例名也改准确了。

第四个 `agent-interactions.ts` 就是上面要删的那个，删完它就不在改动清单里了。

manifest 我已经把前三个加进白名单。

## 顺带一件事

你把 `agent-tools.patch.test.ts` 那条既有用例改了，这是对的，但**没有在第 6 节提一句**。以后凡是动到任务说明白名单之外的文件、或改了既有用例，都要在第 6 节点명——哪个文件、为什么必须动。这次不算违规（我白名单写漏了），但下次照此办。

## 自检

- `rtk proxy grep -rn readAlways apps/studio/src` 应该一条都搜不到
- `git status --short` 里只剩这五个文件：`permissions.ts`、`permissions.test.ts`、`i18n.ts`、`inline-interactions.tsx`、`agent-tools.patch.test.ts`

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/27-split-external-write.json
```

输出原样贴进汇报第 4 节。汇报按六节格式写。
