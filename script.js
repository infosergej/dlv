    // Inicializacija
    const map = L.map('map').setView([54.6872, 25.2797], 11);

    // Šaltinius galima perjungti be kodo keitimo: ?tiles=carto
    const TILE_SOURCES = {
        osm: {
            url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            options: {
                maxZoom: 19,
                referrerPolicy: 'strict-origin-when-cross-origin',
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
                    + '<span class="attribution-extra"> · '
                    + '<a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener">Klaida žemėlapyje?</a></span>'
            }
        },
        carto: {
            url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
            options: {
                maxZoom: 20,
                subdomains: 'abcd',
                referrerPolicy: 'strict-origin-when-cross-origin',
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors &copy; '
                    + '<a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>'
            }
        }
    };

    const requestedTiles = new URLSearchParams(window.location.search).get('tiles');
    const tileSourceKey = Object.prototype.hasOwnProperty.call(TILE_SOURCES, requestedTiles) ? requestedTiles : 'osm';
    const tileSource = TILE_SOURCES[tileSourceKey];

    const tileLayer = L.tileLayer(tileSource.url, tileSource.options).addTo(map);

    let tileLoaded = false;
    let tileFailures = 0;

    tileLayer.on('tileload', () => {
        tileLoaded = true;
        if (window.location.protocol !== 'file:') hideMapWarning();
    });

    tileLayer.on('tileerror', () => {
        tileFailures++;
        if (tileLoaded || tileFailures < 3 || window.location.protocol === 'file:') return;

        if (tileSourceKey === 'osm') {
            showMapWarning('Nepavyko įkelti žemėlapio plytelių. OpenStreetMap blokuoja programas be '
                + '<code>Referer</code> antraštės arba viršijančias jų naudojimo taisykles. '
                + 'Atidarykite programą per <code>http(s)</code>, o jei klaida išlieka — žr. '
                + '<a href="https://osm.wiki/Blocked" target="_blank" rel="noopener">osm.wiki/Blocked</a>. '
                + 'Laikinai galima perjungti plyteles: <a href="?tiles=carto">?tiles=carto</a>.');
        } else {
            showMapWarning('Nepavyko įkelti žemėlapio plytelių. Patikrinkite interneto ryšį arba grįžkite prie '
                + '<a href="?tiles=osm">OpenStreetMap</a> plytelių.');
        }
    });

    // Atidarius failą tiesiogiai (file://) Referer neegzistuoja, todėl OSM plytelės bus blokuojamos
    if (window.location.protocol === 'file:') {
        showMapWarning('Programa atidaryta kaip failas (<code>file://</code>). Žemėlapio plytelės ir PWA veikia tik per '
            + '<code>http(s)</code>. Paleiskite <code>npx serve .</code> arba <code>python -m http.server</code> '
            + 'ir atidarykite <code>http://localhost:8000</code>.');
    }

    function showMapWarning(message) {
        const box = document.getElementById('map-warning');
        const text = document.getElementById('map-warning-text');
        if (!box || !text) return;
        text.innerHTML = message;
        box.hidden = false;
    }

    function hideMapWarning() {
        const box = document.getElementById('map-warning');
        if (box) box.hidden = true;
    }

    // Если пользователь сам сдвинул карту — не тянем её обратно за машиной
    map.on('dragstart', () => { followUser = false; });

    let initialMarkersGroup = L.layerGroup().addTo(map);
    let routeMarkersGroup = L.layerGroup().addTo(map);
    let routingControl = null;
    let searchTimeout = null;
    let startPoint = null;
    let isRouteCurrentlyBuilt = false; // ИЗМЕНЕНИЕ: Переменная для отслеживания статуса маршрута
    let gpsState = 0; // 0 - выключено, 1 - точка поставлена, 2 - включен LIVE
    let gpsWatchId = null;       // Сюда запишется ID постоянного слежения, чтобы его можно было выключить
    let userLocationMarker = null; // Отдельный маркер для текущего положения водителя
    let accuracyCircle = null;     // Круг точности GPS
    let followUser = true;         // Следить ли за машиной автоматически
    let searchAbortController = null; // Позволяет отменить устаревший запрос автодополнения
    const MAX_GOOGLE_WAYPOINTS = 9; // Google Maps принимает не более 9 промежуточных точек
    

    // --- Вспомогательные функции ---

    // Экранирование пользовательских данных перед вставкой в HTML
    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[ch]));
    }

    // Приводит значение к конечному числу или возвращает null
    function toFiniteNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        const num = typeof value === 'number' ? value : parseFloat(value);
        return Number.isFinite(num) ? num : null;
    }

    // Единый шаблон элемента списка адресов
    function createAddressListItem(title, lat, lng) {
        const li = document.createElement('li');
        li.className = 'address-item';
        li.setAttribute('data-lat', lat);
        li.setAttribute('data-lng', lng);
        li.setAttribute('data-title', title);

        li.innerHTML = `
            <div class="drag-handle" aria-hidden="true"><svg class="icon icon-sm"><use href="#i-grip"></use></svg></div>
            <div class="address-content">
                <div class="address-title">${escapeHtml(title)}</div>
                <div class="address-meta">${lat.toFixed(4)}, ${lng.toFixed(4)}</div>
            </div>
            <div class="address-actions">
                <select class="position-select" onchange="changePosition(this)" title="Pozicija maršrute" aria-label="Pozicija maršrute"></select>
                <button class="delete-btn" onclick="deleteItem(this)" title="Pašalinti adresą" aria-label="Pašalinti adresą"><svg class="icon icon-sm"><use href="#i-trash"></use></svg></button>
            </div>
        `;

        return li;
    }

    function formatDistance(meters) {
        if (meters < 1000) return `${Math.round(meters)} m`;
        return `${(meters / 1000).toFixed(1)} km`;
    }

    function formatDuration(seconds) {
        const minutes = Math.max(1, Math.round(seconds / 60));
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        if (hours === 0) return `${minutes} min`;
        return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
    }

    function showRouteSummary(distanceMeters, timeSeconds) {
        const box = document.getElementById('route-summary');
        const text = document.getElementById('route-summary-text');
        if (!box || !text) return;

        if (!Number.isFinite(distanceMeters) || !Number.isFinite(timeSeconds)) {
            hideRouteSummary();
            return;
        }

        text.textContent = `${formatDistance(distanceMeters)} · ${formatDuration(timeSeconds)}`;
        box.hidden = false;
        setRouteActionsVisible(true);
    }

    function showRouteSummaryMessage(message) {
        const box = document.getElementById('route-summary');
        const text = document.getElementById('route-summary-text');
        if (!box || !text) return;

        text.textContent = message;
        box.hidden = false;
        setRouteActionsVisible(false);
    }

    function hideRouteSummary() {
        const box = document.getElementById('route-summary');
        if (box) box.hidden = true;
        setRouteActionsVisible(false);
    }

    function setRouteActionsVisible(visible) {
        const btn = document.getElementById('gmaps-route-btn');
        if (btn) btn.hidden = !visible;
    }

    function hasDeliveryPoints() {
        return document.querySelectorAll('.address-item').length > 0;
    }

    // Drag-and-Drop
    const list = document.getElementById('address-list');
    Sortable.create(list, {
        handle: '.drag-handle',
        animation: 150,
        onEnd: () => { 
            updateListState(); 
            refreshInitialMarkers(); 
            // ИЗМЕНЕНИЕ: Если маршрут уже был построен, перестраиваем его при перетаскивании
            if (isRouteCurrentlyBuilt) {
                buildFinalRoute(false); // false означает "не скроллить экран вверх"
            } else {
                saveDataToLocalStorage(); 
            }
        }
    });

    // Функция сохранения данных в localStorage
    function saveDataToLocalStorage() {
        const items = [];
        document.querySelectorAll('.address-item').forEach(item => {
            items.push({
                title: item.getAttribute('data-title'),
                lat: parseFloat(item.getAttribute('data-lat')),
                lng: parseFloat(item.getAttribute('data-lng'))
            });
        });

        const dataToSave = {
            startPoint: startPoint,
            deliveryAddresses: items,
            routeBuilt: isRouteCurrentlyBuilt // ИЗМЕНЕНИЕ: Сохраняем статус линии маршрута
        };

        localStorage.setItem('adpakas_route_data', JSON.stringify(dataToSave));
    }

    // Функция загрузки данных из localStorage при открытии
    function loadDataFromLocalStorage() {
        const savedData = localStorage.getItem('adpakas_route_data');
        if (!savedData) return;

        let data;
        try {
            data = JSON.parse(savedData);
        } catch (e) {
            console.error("Klaida įkeliant išsaugotus duomenis:", e);
            return;
        }
        if (!data || typeof data !== 'object') return;

        // Восстанавливаем стартовую точку (только с корректными координатами)
        const startLat = data.startPoint ? toFiniteNumber(data.startPoint.lat) : null;
        const startLng = data.startPoint ? toFiniteNumber(data.startPoint.lng) : null;

        if (startLat !== null && startLng !== null) {
            startPoint = {
                title: String(data.startPoint.title || 'Startas'),
                lat: startLat,
                lng: startLng
            };
            document.getElementById('start-point-text').textContent = startPoint.title;
            document.getElementById('start-point-display').style.display = 'flex';
        }

        // Восстанавливаем адреса доставки, пропуская поврежденные записи
        const savedAddresses = Array.isArray(data.deliveryAddresses) ? data.deliveryAddresses : [];
        const loadedAddresses = [];
        const listContainer = document.getElementById('address-list');

        savedAddresses.forEach(addr => {
            const lat = addr ? toFiniteNumber(addr.lat) : null;
            const lng = addr ? toFiniteNumber(addr.lng) : null;
            if (lat === null || lng === null) return;

            const title = String((addr && addr.title) || 'Adresas');
            loadedAddresses.push({ title, lat, lng });
            listContainer.appendChild(createAddressListItem(title, lat, lng));
        });

        if (!startPoint && loadedAddresses.length === 0) return;

        updateListState();
        refreshInitialMarkers();

        // Если до перезагрузки маршрут был построен, строим его автоматически
        if (data.routeBuilt && startPoint && loadedAddresses.length > 0) {
            buildFinalRoute(false);
        } else if (startPoint) {
            map.setView([startPoint.lat, startPoint.lng], 12);
        } else if (loadedAddresses.length > 0) {
            map.setView([loadedAddresses[0].lat, loadedAddresses[0].lng], 12);
        }
    }

    // Meniu perjungimas: būseną valdo CSS klasė, JS tik atnaujina užrašą
    function toggleSidebar() {
        const body = document.body;
        const isHidden = body.classList.toggle('sidebar-hidden');
        const btn = document.getElementById('toggle-sidebar-btn');
        const label = btn.querySelector('.btn-label');
        const text = isHidden ? 'Rodyti meniu' : 'Paslėpti meniu';

        if (label) label.textContent = text;
        btn.title = text;
        btn.setAttribute('aria-expanded', String(!isHidden));

        setTimeout(() => {
            map.invalidateSize({ animate: true });
        }, 280);
    }

    window.addEventListener('resize', () => {
        map.invalidateSize();
    });

    function debounceSearch(value, type) {
        clearTimeout(searchTimeout);
        const boxId = type === 'start' ? 'start-suggestions' : 'suggestions';
        const suggestionsBox = document.getElementById(boxId);
        const query = value.trim();

        if (query.length < 3) {
            suggestionsBox.style.display = 'none';
            suggestionsBox.textContent = '';
            if (searchAbortController) {
                searchAbortController.abort();
                searchAbortController = null;
            }
            return;
        }

        // Nominatim politika: ne daugiau kaip 1 užklausa per sekundę
        searchTimeout = setTimeout(() => {
            fetchSuggestions(query, type);
        }, 1000);
    }

    function showSuggestionMessage(box, message) {
        box.textContent = '';
        const div = document.createElement('div');
        div.className = 'suggestion-item suggestion-info';
        div.textContent = message;
        box.appendChild(div);
        box.style.display = 'block';
    }

    function fetchSuggestions(query, type) {
        const boxId = type === 'start' ? 'start-suggestions' : 'suggestions';
        const suggestionsBox = document.getElementById(boxId);

        // Отменяем предыдущий запрос, чтобы устаревший ответ не перезаписал новый
        if (searchAbortController) searchAbortController.abort();
        searchAbortController = new AbortController();
        const { signal } = searchAbortController;

        showSuggestionMessage(suggestionsBox, 'Ieškoma…');

        // ОПТИМИЗАЦИЯ ЗАПРОСА:
        // viewbox=20.9,56.5,26.9,53.8 — это географические границы Литвы.
        // bounded=1 — принудительно заставляет искать ИМЕННО внутри этих границ.
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=lt&addressdetails=1&accept-language=lt&limit=7&viewbox=20.9,56.5,26.9,53.8&bounded=1`;

        fetch(url, { signal })
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            })
            .then(data => {
                if (signal.aborted) return;
                suggestionsBox.textContent = '';

                if (!Array.isArray(data) || data.length === 0) {
                    showSuggestionMessage(suggestionsBox, 'Nieko nerasta. Patikslinkite adresą.');
                    return;
                }

                data.forEach(item => {
                    const div = document.createElement('div');
                    div.className = 'suggestion-item';
                    div.setAttribute('role', 'option');

                    const addr = item.address || {};
                    let placeName = item.name || '';

                    const street = addr.road || addr.pedestrian || addr.cycleway || '';
                    const house = addr.house_number || '';
                    const city = addr.city || addr.town || addr.village || addr.municipality || '';
                    const suburb = addr.suburb || addr.neighbourhood || '';

                    let addressParts = [];

                    if (placeName && placeName !== street && placeName !== city) {
                        addressParts.push(placeName);
                    }
                    if (street) {
                        addressParts.push(street + (house ? ' ' + house : ''));
                    }
                    if (suburb) addressParts.push(suburb);
                    if (city) addressParts.push(city);

                    let cleanAddress = addressParts.filter(Boolean).join(', ');

                    // ЗАПАСНОЙ ПЛАН: Если склеенный адрес пустой или слишком короткий,
                    // берем полное имя от сервера (убирая "Lietuva" для красоты)
                    if (!street || !cleanAddress || cleanAddress.length < 6) {
                        cleanAddress = String(item.display_name || '').replace(', Lietuva', '');
                    }

                    const lat = parseFloat(item.lat);
                    const lon = parseFloat(item.lon);
                    if (!cleanAddress || !Number.isFinite(lat) || !Number.isFinite(lon)) return;

                    div.textContent = cleanAddress;

                    div.onclick = () => {
                        if (type === 'start') {
                            setStartPoint(cleanAddress, lat, lon);
                        } else {
                            addAddressToList(cleanAddress, lat, lon);
                        }
                        suggestionsBox.style.display = 'none';
                        const inputId = type === 'start' ? 'start-input' : 'address-input';
                        document.getElementById(inputId).value = '';
                    };
                    suggestionsBox.appendChild(div);
                });

                suggestionsBox.style.display = 'block';
            })
            .catch(err => {
                if (err.name === 'AbortError') return;
                showSuggestionMessage(suggestionsBox, 'Nepavyko atlikti paieškos. Patikrinkite interneto ryšį.');
            });
    }

    // Закрываем подсказки по клику вне поля поиска и по Escape
    document.addEventListener('click', (event) => {
        if (event.target.closest('.search-container')) return;
        document.querySelectorAll('.suggestions-box').forEach(box => {
            box.style.display = 'none';
        });
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        document.querySelectorAll('.suggestions-box').forEach(box => {
            box.style.display = 'none';
        });
    });

    function setStartPoint(title, lat, lng) {
        clearRouteLine();
        startPoint = { title, lat, lng };
        document.getElementById('start-point-text').textContent = title;
        document.getElementById('start-point-display').style.display = 'flex';
        map.setView([lat, lng], 13);
        refreshInitialMarkers();
        updateListState();
        saveDataToLocalStorage(); 
    }

    function addAddressToList(title, lat, lng) {
        const wasRouteBuilt = isRouteCurrentlyBuilt;
        clearRouteLine();

        document.getElementById('address-list').appendChild(createAddressListItem(title, lat, lng));
        map.setView([lat, lng], 13);
        updateListState();
        refreshInitialMarkers();

        // Если маршрут уже был построен — перестраиваем его с учетом нового адреса
        if (wasRouteBuilt && startPoint) {
            buildFinalRoute(false);
        } else {
            saveDataToLocalStorage();
        }
    }

    function updateListState() {
        const items = document.querySelectorAll('.address-item');
        const total = items.length;
        document.getElementById('count').textContent = `${total} gavėjų`;
        document.getElementById('route-btn').disabled = !(startPoint && total >= 1);

        items.forEach((item, index) => {
            const select = item.querySelector('.position-select');
            select.innerHTML = '';
            for (let i = 1; i <= total; i++) {
                let opt = document.createElement('option');
                opt.value = i; opt.textContent = i;
                if (i === (index + 1)) opt.selected = true;
                select.appendChild(opt);
            }
        });
    }
    // Nauja funkcija: Visiškas Starto pozicijos (A taško) pašalinimas
    function deleteStartPoint() {
        if (confirm("Ar tikrai norite pašalinti starto poziciją (A tašką)?")) {
            // 1. Стираем линию маршрута с карты, так как без старта его быть не может
            clearRouteLine();
            
            // 2. Сбрасываем переменную старта в null
            startPoint = null;
            
            // 3. Прячем блок отображения на панели и очищаем текст
            document.getElementById('start-point-display').style.display = 'none';
            document.getElementById('start-point-text').textContent = '';

            // 4. Сбрасываем GPS-кнопку в исходное состояние
            resetGpsButton();

            // 5. Обновляем счетчики и блокируем кнопку "Sukurti maršrutą"
            updateListState();
            
            // 6. Перерисовываем маркеры на карте (останутся только точки доставки)
            refreshInitialMarkers();
            
            // 7. Сохраняем пустой старт в память браузера (localStorage)
            saveDataToLocalStorage();
        }
    }

    function changePosition(selectElement) {
        const wasRouteBuilt = isRouteCurrentlyBuilt;
        clearRouteLine();
        const itemToMove = selectElement.closest('.address-item');
        const targetPosition = parseInt(selectElement.value) - 1;
        const listContainer = document.getElementById('address-list');
        
        listContainer.removeChild(itemToMove);
        const currentItems = document.querySelectorAll('.address-item');
        
        if (targetPosition >= currentItems.length) {
            listContainer.appendChild(itemToMove);
        } else {
            listContainer.insertBefore(itemToMove, currentItems[targetPosition]);
        }
        updateListState();
        refreshInitialMarkers();
        
        // Если маршрут уже был на экране, автоматически перестраиваем его с учетом нового порядка
        if (wasRouteBuilt && startPoint) {
            buildFinalRoute(false);
        } else {
            saveDataToLocalStorage();
        }
    }

    function deleteItem(buttonElement) {
        if (!confirm("Ar tikrai norite pašalinti šį adresą iš maršruto?")) return;

        const wasRouteBuilt = isRouteCurrentlyBuilt;
        clearRouteLine();
        buttonElement.closest('.address-item').remove();
        updateListState();
        refreshInitialMarkers();

        if (wasRouteBuilt && startPoint && hasDeliveryPoints()) {
            buildFinalRoute(false);
        } else {
            saveDataToLocalStorage();
        }
    }

    // Функция удаления адреса при клике на кнопку внутри маркера на карте
    function deleteItemByIndex(index) {
        const items = document.querySelectorAll('.address-item');
        if (!items[index]) return;

        if (!confirm("Ar tikrai norite pašalinti šį adresą iš maršruto?")) return;

        const wasRouteBuilt = isRouteCurrentlyBuilt;
        clearRouteLine();
        items[index].remove(); // Удаляем элемент из HTML-списка
        updateListState();
        refreshInitialMarkers();

        if (wasRouteBuilt && startPoint && hasDeliveryPoints()) {
            buildFinalRoute(false);
        } else {
            saveDataToLocalStorage();
        }
    }

    function refreshInitialMarkers() {
    initialMarkersGroup.clearLayers();
    if (startPoint) {
        const startIcon = L.divIcon({ className: 'number-marker start-marker', html: 'S' });
        const popupContent = `
            <div class="info-popup">
                <div class="info-popup__eyebrow">Maršruto pradžia</div>
                <div class="info-popup__title">${escapeHtml(startPoint.title)}</div>
            </div>
        `;
        L.marker([startPoint.lat, startPoint.lng], { icon: startIcon }).addTo(initialMarkersGroup).bindPopup(popupContent);
    }
    
    document.querySelectorAll('.address-item').forEach((item, index) => {
        const lat = parseFloat(item.getAttribute('data-lat'));
        const lng = parseFloat(item.getAttribute('data-lng'));
        const title = item.getAttribute('data-title');
        
        const numberIcon = L.divIcon({ className: 'number-marker', html: index + 1 });
        
        const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
        
        // ОБНОВЛЕНО: Добавлена кнопка "Pašalinti adresą" (Удалить адрес), которая вызывает новую функцию deleteItemByIndex
        const popupContent = `
            <div class="info-popup">
                <div class="info-popup__eyebrow">Gavėjas ${index + 1}</div>
                <div class="info-popup__title">${escapeHtml(title)}</div>
                <div class="info-popup__meta">${lat.toFixed(4)}, ${lng.toFixed(4)}</div>
                <a class="info-popup__btn" href="${googleMapsUrl}" target="_blank" rel="noopener">Google Maps</a>
                <button class="info-popup__btn info-popup__btn--danger" onclick="deleteItemByIndex(${index})">Pašalinti adresą</button>
            </div>
        `;
        
        L.marker([lat, lng], { icon: numberIcon }).addTo(initialMarkersGroup).bindPopup(popupContent);
    });
}

    function clearRouteLine() {
        if (routingControl !== null) { map.removeControl(routingControl); routingControl = null; }
        routeMarkersGroup.clearLayers();
        isRouteCurrentlyBuilt = false; // ИЗМЕНЕНИЕ: Сбрасываем статус при стирании линии
        hideRouteSummary();
        refreshInitialMarkers();
        saveDataToLocalStorage(); // ИЗМЕНЕНИЕ: Сохраняем факт того, что маршрут сброшен
    }

    // Открывает весь маршрут (старт + все адреса) в Google Maps для навигации
    function openRouteInGoogleMaps() {
        if (!startPoint) return;

        const points = [];
        document.querySelectorAll('.address-item').forEach(item => {
            const lat = toFiniteNumber(item.getAttribute('data-lat'));
            const lng = toFiniteNumber(item.getAttribute('data-lng'));
            if (lat !== null && lng !== null) points.push({ lat, lng });
        });

        if (points.length === 0) return;

        let targets = points;
        if (targets.length > MAX_GOOGLE_WAYPOINTS + 1) {
            targets = targets.slice(0, MAX_GOOGLE_WAYPOINTS + 1);
            alert(`Google Maps leidžia iki ${MAX_GOOGLE_WAYPOINTS} tarpinių taškų. Atidaromas pirmųjų ${targets.length} adresų maršrutas.`);
        }

        const destination = targets[targets.length - 1];
        const waypoints = targets.slice(0, -1);

        let url = 'https://www.google.com/maps/dir/?api=1&travelmode=driving'
            + `&origin=${startPoint.lat},${startPoint.lng}`
            + `&destination=${destination.lat},${destination.lng}`;

        if (waypoints.length > 0) {
            url += `&waypoints=${waypoints.map(point => `${point.lat},${point.lng}`).join('|')}`;
        }

        window.open(url, '_blank', 'noopener');
    }

    // ИЗМЕНЕНИЕ: Добавлен аргумент shouldScroll (по умолчанию true), чтобы страница не прыгала при автозагрузке
   function buildFinalRoute(shouldScroll = true) {
        if (!startPoint) return;
        if (routingControl !== null) { map.removeControl(routingControl); }
        routeMarkersGroup.clearLayers();
        initialMarkersGroup.clearLayers();
        hideRouteSummary();

        const waypoints = [];
        waypoints.push(L.latLng(startPoint.lat, startPoint.lng));
        
        const startIcon = L.divIcon({ className: 'number-marker start-marker', html: 'S' });
        
        // Кнопка для старта на проложенном маршруте
        const startGpsUrl = `https://www.google.com/maps/dir/?api=1&destination=${startPoint.lat},${startPoint.lng}`;
        const startPopup = `
            <div class="info-popup">
                <div class="info-popup__eyebrow">Maršruto pradžia</div>
                <div class="info-popup__title">${escapeHtml(startPoint.title)}</div>
                <a class="info-popup__btn" href="${startGpsUrl}" target="_blank" rel="noopener">Google Maps</a>
            </div>
        `;
        L.marker([startPoint.lat, startPoint.lng], { icon: startIcon }).addTo(routeMarkersGroup).bindPopup(startPopup);

        document.querySelectorAll('.address-item').forEach((item, index) => {
        const lat = parseFloat(item.getAttribute('data-lat'));
        const lng = parseFloat(item.getAttribute('data-lng'));
        const title = item.getAttribute('data-title');
        waypoints.push(L.latLng(lat, lng));

        const numberIcon = L.divIcon({ className: 'number-marker', html: index + 1 });
        
        const addressGpsUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
        
        // ОБНОВЛЕНО: Здесь тоже добавлена кнопка удаления по индексу
        const addressPopup = `
            <div class="info-popup">
                <div class="info-popup__eyebrow">Gavėjas ${index + 1}</div>
                <div class="info-popup__title">${escapeHtml(title)}</div>
                <div class="info-popup__meta">${lat.toFixed(4)}, ${lng.toFixed(4)}</div>
                <a class="info-popup__btn" href="${addressGpsUrl}" target="_blank" rel="noopener">Google Maps</a>
                <button class="info-popup__btn info-popup__btn--danger" onclick="deleteItemByIndex(${index})">Pašalinti adresą</button>
            </div>
        `;
        L.marker([lat, lng], { icon: numberIcon }).addTo(routeMarkersGroup).bindPopup(addressPopup);
    });

        routingControl = L.Routing.control({
            waypoints: waypoints,
            lineOptions: { styles: [
                { color: '#ffffff', weight: 9, opacity: 0.9 },
                { color: '#4f46e5', weight: 5, opacity: 1 }
            ] },
            createMarker: function() { return null; },
            addWaypoints: false,
            show: false
        }).addTo(map);

        // Показываем общую дистанцию и время маршрута
        routingControl.on('routesfound', (event) => {
            const summary = event.routes && event.routes[0] ? event.routes[0].summary : null;
            if (!summary) {
                showRouteSummaryMessage('Maršrutas sukurtas, bet nepavyko gauti jo santraukos.');
                return;
            }
            showRouteSummary(summary.totalDistance, summary.totalTime);
        });

        routingControl.on('routingerror', () => {
            showRouteSummaryMessage('Nepavyko apskaičiuoti maršruto. Patikrinkite interneto ryšį ir bandykite dar kartą.');
        });

        isRouteCurrentlyBuilt = true; 
        saveDataToLocalStorage();    

        if (shouldScroll && window.innerWidth <= 768) {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }

    // Пошаговое управление GPS: 1-й клик (Старт), 2-й клик (LIVE), 3-й клик (Выключение)
    // Пошаговое управление GPS (Строго 1 нажатие = 1 действие)
function findMyLocation() {
    if (!navigator.geolocation) {
        alert("Jūsų naršyklė nepalaiko GPS funkcijos.");
        return;
    }

    switch (gpsState) {
        case 0:
            // === ШАГ 1: ПЕРВОЕ НАЖАТИЕ — Одиночный Старт ===
            setGpsButtonState('loading');

            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const lat = position.coords.latitude;
                    const lng = position.coords.longitude;
                    const title = `Mano vieta (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
                    
                    setStartPoint(title, lat, lng);
                    
                    // Строго переключаем на шаг 1
                    gpsState = 1;
                    setGpsButtonState('active');
                },
                (error) => {
                    resetGpsButton();
                    handleGpsError(error);
                },
                { enableHighAccuracy: true, timeout: 10000 }
            );
            break;

        case 1:
            // === ШАГ 2: ВТОРОЕ НАЖАТИЕ — Включение LIVE трекинга ===
            setGpsButtonState('loading');
            followUser = true;

            gpsWatchId = navigator.geolocation.watchPosition(
                (position) => {
                    const lat = position.coords.latitude;
                    const lng = position.coords.longitude;
                    const accuracy = Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null;
                    
                    // Переводим кнопку в режим LIVE (Зеленая)
                    setGpsButtonState('live');

                    // Круг точности GPS
                    if (accuracy !== null) {
                        if (accuracyCircle === null) {
                            accuracyCircle = L.circle([lat, lng], {
                                radius: accuracy,
                                color: '#4285F4',
                                weight: 1,
                                fillColor: '#4285F4',
                                fillOpacity: 0.12
                            }).addTo(map);
                        } else {
                            accuracyCircle.setLatLng([lat, lng]);
                            accuracyCircle.setRadius(accuracy);
                        }
                    }

                    // Создаем или плавно передвигаем маркер машины
                    if (userLocationMarker === null) {
                        const driverIcon = L.divIcon({
                            className: 'number-marker driver-marker',
                            html: '<svg class="icon"><use href="#i-car"></use></svg>'
                        });
                        userLocationMarker = L.marker([lat, lng], { icon: driverIcon }).addTo(map)
                            .bindPopup(`
                                <div class="info-popup">
                                    <div class="info-popup__eyebrow">GPS</div>
                                    <div class="info-popup__title">Jūsų esama pozicija</div>
                                </div>
                            `);
                        followUser = true;
                        map.setView([lat, lng], 16); 
                    } else {
                        userLocationMarker.setLatLng([lat, lng]);
                        // Ведем карту за машиной, только если пользователь не сдвинул её сам
                        if (followUser) map.panTo([lat, lng]);
                    }
                },
                (error) => {
                    resetGpsButton();
                    handleGpsError(error);
                },
                { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
            );

            // МГНОВЕННО переводим состояние кнопки в Шаг 2, 
            // чтобы следующее нажатие сразу уходило в отключение, 
            // не дожидаясь ответа от спутников
            gpsState = 2; 
            break;

        case 2:
            // === ШАГ 3: ТРЕТЬЕ НАЖАТИЕ — Полное отключение LIVE ===
            resetGpsButton();
            break;
    }
}

// Визуальное состояние GPS-кнопки: idle | loading | active | live
function setGpsButtonState(state) {
    const btn = document.getElementById('gps-btn');
    if (!btn) return;

    btn.classList.remove('is-active', 'is-live', 'is-loading');
    if (state !== 'idle') btn.classList.add(`is-${state}`);

    const labels = {
        idle: 'Nustatyti mano vietą',
        loading: 'Nustatoma vieta…',
        active: 'Įjungti GPS sekimą',
        live: 'Išjungti GPS sekimą'
    };
    const label = labels[state] || labels.idle;
    btn.title = label;
    btn.setAttribute('aria-label', label);
}

// Полный сброс GPS: останавливаем отслеживание, убираем маркер и круг точности
function resetGpsButton() {
    // Одозначно останавливаем слежение в системе телефона
    if (gpsWatchId !== null) {
        navigator.geolocation.clearWatch(gpsWatchId);
        gpsWatchId = null;
    }
    
    // Убираем машинку с карты
    if (userLocationMarker !== null) {
        map.removeLayer(userLocationMarker);
        userLocationMarker = null;
    }

    // Убираем круг точности GPS
    if (accuracyCircle !== null) {
        map.removeLayer(accuracyCircle);
        accuracyCircle = null;
    }

    followUser = true;

    // Сбрасываем статус в ноль
    gpsState = 0;
    setGpsButtonState('idle');
}

// Функция вывода ошибок GPS
function handleGpsError(error) {
    switch(error.code) {
        case error.PERMISSION_DENIED:
            alert("Klaida: Jūs uždraudėte prieigą prie savo vietovės.");
            break;
        case error.POSITION_UNAVAILABLE:
            alert("Klaida: Nepavyko nustatyti vietos.");
            break;
        case error.TIMEOUT:
            alert("Klaida: Baigėsi vietos nustatymo laikas.");
            break;
        default:
            alert("Įvyko nežinoma GPS klaida.");
    }
}

    // Инициализация загрузки сохраненных данных при старте скрипта
    loadDataFromLocalStorage();