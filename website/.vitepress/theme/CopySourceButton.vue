<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useData } from 'vitepress'

const { page } = useData()
const isOpen = ref(false)
const copied = ref(false)
const dropdownRef = ref<HTMLElement | null>(null)

const sourceUrl = computed(() => {
  return `https://raw.githubusercontent.com/coji/durably/main/website/${page.value.relativePath}`
})

const claudeUrl = computed(() => {
  const query = encodeURIComponent(`Read from ${sourceUrl.value} so I can ask questions about it.`)
  return `https://claude.ai/new?q=${query}`
})

function toggleDropdown() {
  isOpen.value = !isOpen.value
}

function closeDropdown(e: MouseEvent) {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target as Node)) {
    isOpen.value = false
  }
}

async function copyPage(closeMenu = false) {
  try {
    const response = await fetch(sourceUrl.value)
    const text = await response.text()
    await navigator.clipboard.writeText(text)
    copied.value = true
    setTimeout(() => {
      copied.value = false
      if (closeMenu) {
        isOpen.value = false
      }
    }, 1500)
  } catch (error) {
    console.error('Failed to copy source:', error)
  }
}

function viewAsMarkdown() {
  window.open(sourceUrl.value, '_blank')
  isOpen.value = false
}

function openInClaude() {
  window.open(claudeUrl.value, '_blank')
  isOpen.value = false
}

onMounted(() => {
  document.addEventListener('click', closeDropdown)
})

onUnmounted(() => {
  document.removeEventListener('click', closeDropdown)
})
</script>

<template>
  <div class="copy-page-container" ref="dropdownRef">
    <div class="split-button">
      <button class="copy-page-button" @click="copyPage">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        <span>{{ copied ? 'Copied!' : 'Copy page' }}</span>
      </button>
      <span class="separator"></span>
      <button class="dropdown-toggle" @click="toggleDropdown">
        <svg class="chevron" :class="{ open: isOpen }" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
    </div>

    <div v-if="isOpen" class="dropdown-menu">
      <button class="dropdown-item" @click="copyPage(true)">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        <div class="item-content">
          <span class="item-title">{{ copied ? 'Copied!' : 'Copy page' }}</span>
          <span class="item-description">Copy page as Markdown for LLMs</span>
        </div>
      </button>

      <button class="dropdown-item" @click="viewAsMarkdown">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
          <polyline points="10 9 9 9 8 9"></polyline>
        </svg>
        <div class="item-content">
          <span class="item-title">View as Markdown<span class="external-icon">↗</span></span>
          <span class="item-description">View this page as plain text</span>
        </div>
      </button>

      <button class="dropdown-item" @click="openInClaude">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"></path>
        </svg>
        <div class="item-content">
          <span class="item-title">Open in Claude<span class="external-icon">↗</span></span>
          <span class="item-description">Ask questions about this page</span>
        </div>
      </button>
    </div>
  </div>
</template>

<style scoped>
.copy-page-container {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 16px;
  position: relative;
}

.split-button {
  display: inline-flex;
  align-items: stretch;
  background-color: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  overflow: hidden;
}

.copy-page-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-2);
  background: none;
  border: none;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.copy-page-button:hover {
  background-color: var(--vp-c-bg-mute);
}

.copy-page-button svg {
  flex-shrink: 0;
}

.separator {
  width: 1px;
  background-color: var(--vp-c-divider);
}

.dropdown-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 8px 10px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--vp-c-text-2);
  transition: background-color 0.15s ease;
}

.dropdown-toggle:hover {
  background-color: var(--vp-c-bg-mute);
}

.chevron {
  transition: transform 0.2s ease;
}

.chevron.open {
  transform: rotate(180deg);
}

.dropdown-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 280px;
  background-color: var(--vp-c-bg-elv);
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  z-index: 100;
  overflow: hidden;
  padding: 6px;
}

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 10px;
  text-align: left;
  background-color: transparent;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.dropdown-item:hover {
  background-color: var(--vp-c-default-soft) !important;
}

.dropdown-item:hover .item-title {
  color: var(--vp-c-brand-1);
}

.dropdown-item :deep(svg) {
  flex-shrink: 0;
  color: var(--vp-c-text-2);
  padding: 6px;
  background-color: var(--vp-c-bg-soft);
  border-radius: 6px;
  box-sizing: content-box;
}

.item-content {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.item-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-1);
  transition: color 0.15s ease;
}

.item-description {
  font-size: 12px;
  color: var(--vp-c-text-3);
}

.external-icon {
  margin-left: 4px;
  font-size: 11px;
}
</style>
