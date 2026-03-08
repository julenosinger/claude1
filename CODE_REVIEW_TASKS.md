# Revisão da base de código: tarefas recomendadas

## 1) Tarefa de correção de erro de digitação
**Problema identificado:** no mock de contratos, o título `"Yield Strategy — USYC Apr"` aparenta usar `Apr` como abreviação inconsistente para rendimento anual (mais comum: `APR`).

**Tarefa sugerida:**
- Padronizar o texto para `"Yield Strategy — USYC APR"` (ou a nomenclatura de produto oficial definida pelo time).
- Revisar os demais textos mockados para manter siglas financeiras em caixa consistente.

---

## 2) Tarefa de correção de bug
**Problema identificado:** as funções de formatação convertem `BigInt` para `Number` (`Number(wei)` e `Number(BigInt(raw))`), o que pode causar perda de precisão para valores altos.

**Tarefa sugerida:**
- Substituir a formatação baseada em `Number` por rotina segura com `BigInt` (separando parte inteira/fracionária por escala de decimais).
- Cobrir casos de borda com valores grandes (acima de `Number.MAX_SAFE_INTEGER`).
- Garantir que o arredondamento final continue consistente com a UX atual.

---

## 3) Tarefa para ajustar comentário/discrepância de documentação
**Problema identificado:** o comentário da função de detecção de clipboard diz que compara diferenças no "início/fim" e "mais de 4 chars", porém a implementação só compara os 6 primeiros caracteres.

**Tarefa sugerida:**
- Ou atualizar o comentário para refletir exatamente a regra atual.
- Ou atualizar a lógica para realmente comparar início e fim com o limiar descrito.
- Adicionar uma nota curta explicando o racional da heurística para reduzir falsos positivos.

---

## 4) Tarefa para melhorar testes
**Problema identificado:** funções críticas de segurança e formatação (ex.: `detectClipboardHijack`, `analyzeTransactionRisk`, `formatNativeUsdc`, `formatUsdc`) não têm cobertura de testes visível neste repositório.

**Tarefa sugerida:**
- Criar suíte de testes unitários para essas funções.
- Incluir cenários mínimos:
  - clipboard hijack verdadeiro/falso com variações de prefixo e sufixo;
  - risco `critical/high/medium/safe` em `analyzeTransactionRisk`;
  - formatação de valores pequenos, zero e valores muito altos sem perda de precisão.
- Integrar os testes ao comando padrão de validação do projeto.
