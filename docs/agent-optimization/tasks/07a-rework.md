# 任务 07a 返工：把 4 条新用例里的 `python3` 换成纯 shell

源码改得对，**一个字都不要动**。只改 `apps/studio/src/bun/agent-hooks.test.ts`，而且只改你自己新加的那 4 条用例。

现有 14 条用例仍然一条都不许动。

## 为什么要返工

你新加的 4 条用例里，钩子脚本用的是 `python3 -c '...'`。

问题是：

- 这个仓库的**所有**测试里，之前没有任何一条依赖 `python3`。
- `.github/workflows` 里没有任何一步装 Python。
- 这个文件里现有的钩子脚本用的都是 shell 内建命令：`echo`、`cat`、`printf`、`wc`。

所以在没装 python3 的机器或 CI 上，这 4 条会红——而且红的样子像是「这个功能坏了」，会把人引到错误的方向。测试不该引入新的环境依赖。

## 换成这些写法（已在本机实测过，可以直接用）

**取 stdin 的字节数**：

```
wc -c | tr -d " "
```

（实测：`printf 'hello世界'` 传进去输出 `11`，按字节算，正确。）

**判断某个环境变量存没存在**（注意要用 `${VAR+x}` 这种写法，不是 `-n "$VAR"`——后者分不出「未设置」和「设置成空串」）：

```
if [ -n "${OMNI_HOOK_PAYLOAD+x}" ]; then echo 0; else echo 1; fi
```

（实测：未设置输出 `1`，设成 `abc` 输出 `0`，设成空串输出 `0`。）

**比对环境变量与 stdin 的内容是否一致**（先把 stdin 落到工作区里的一个文件，再比）：

```
cat > "$WORKSPACE_DIR/in.json"; if [ "$OMNI_HOOK_PAYLOAD" = "$(cat "$WORKSPACE_DIR/in.json")" ]; then echo True; else echo False; fi
```

（实测含中文时输出 `True`。`$WORKSPACE_DIR` 你按测试里那个临时目录变量替换成真实路径。）

**读环境变量**：直接 `printf '%s' "$OMNI_HOOK_PAYLOAD_BYTES"`，现有第 124 行那条用例就是这么写的，照抄它的风格。

多行输出用 `;` 串起来、每段一个 `echo` 就行，跟你现在的断言格式保持一致。

## 断言不要改

4 条用例的**断言内容和期望值保持不变**，只换实现钩子脚本的手段。比如原来断言 `result.context` 是 `"1\n<字节数>\nuser_prompt_submit"`，换完还应该是这个。

## 自检

改完跑一次，4 条都要绿。另外确认一下：`rtk proxy grep -c python3 apps/studio/src/bun/agent-hooks.test.ts` 应该是 0。

**注意**：这个文件里「stdout 不是 JSON → 整段当上下文」那条是计时敏感的，机器忙时偶尔会红，不是你改坏的，重跑一次一般就绿，不要去动它。

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/07a-hook-payload-env.json
```

输出原样贴进汇报第 4 节。汇报按六节格式写。
