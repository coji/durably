import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import CopySourceButton from './CopySourceButton.vue'

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'doc-before': () => h(CopySourceButton),
    })
  },
}
